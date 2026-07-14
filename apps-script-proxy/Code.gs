const BQ_PROJECT_ID = 'tri-omnichannel-prd';
const BQ_TABLE = 'tri-omnichannel-prd.claude.allofresh_users_quality_v2';
const APP_VERSION = 'pwa-proxy-v1';

function doGet(e) {
  try {
    const action = (e.parameter.action || '').trim();
    const payload = parsePayload_(e.parameter.payload);

    let data;
    if (action === 'metadata') {
      data = getDashboardMetadata();
    } else if (action === 'scorecard') {
      data = getScorecardSummary(payload.filters || {}, payload.group || 'channel', payload.minUsers || 50);
    } else {
      throw new Error('Unknown action: ' + action);
    }

    return json_(data);
  } catch (err) {
    return json_({ error: String(err && err.message ? err.message : err) }, 500);
  }
}

function getDashboardMetadata() {
  const sql = baseCte_() + `
    SELECT
      MIN(install_date) AS dateFrom,
      MAX(install_date) AS dateTo,
      STRING_AGG(DISTINCT CAST(device_type AS STRING), '||' ORDER BY CAST(device_type AS STRING)) AS deviceTypes,
      STRING_AGG(DISTINCT CAST(install_channel AS STRING), '||' ORDER BY CAST(install_channel AS STRING)) AS installChannels,
      STRING_AGG(DISTINCT CAST(store AS STRING), '||' ORDER BY CAST(store AS STRING)) AS stores,
      STRING_AGG(DISTINCT SUBSTR(CAST(\`1st_transaction_date\` AS STRING), 1, 7), '||' ORDER BY SUBSTR(CAST(\`1st_transaction_date\` AS STRING), 1, 7)) AS trxMonths,
      '${APP_VERSION}' AS backendVersion
    FROM base
    WHERE device_id IS NOT NULL
      AND install_channel IS NOT NULL
      AND install_date IS NOT NULL
  `;
  return firstRow_(runQuery_(sql)) || {};
}

function getScorecardSummary(filters, group, minUsers) {
  const groupExpr = scorecardGroupExpr_(group);
  const minN = Math.max(0, Number(minUsers || 50));
  const source = scoredBase_(filterWhere_(filters));
  const sql = baseCte_() + `
    SELECT
      ${groupExpr} AS groupKey,
      COUNT(*) AS users,
      SUM(IF(total_trx > 1 AND days_since_first_trx >= 60, 1, 0)) AS repeatCount,
      SUM(IF(days_since_first_trx >= 60, 1, 0)) AS matured,
      SAFE_DIVIDE(SUM(total_trx), COUNT(*)) AS trxPerUser,
      SAFE_DIVIDE(SUM(gmv), COUNT(*)) AS gmvPerUser,
      SAFE_DIVIDE(SUM(gmv), NULLIF(SUM(total_trx), 0)) AS aov,
      SAFE_DIVIDE(SUM(gross_margin_sum), NULLIF(SUM(gross_revenue_sum), 0)) AS gm,
      SAFE_DIVIDE(SUM(gross_profit_sum), NULLIF(SUM(net_revenue_sum), 0)) AS nm,
      SAFE_DIVIDE(SUM(unique_sku), COUNT(*)) AS sku,
      SAFE_DIVIDE(SUM(unique_category), COUNT(*)) AS cat,
      SUM(gmv) AS gmv
    FROM ${source}
    WHERE \`1st_transaction_date\` IS NOT NULL
      AND ${groupExpr} IS NOT NULL
      AND ${groupExpr} != ''
    GROUP BY groupKey
    HAVING users >= ${minN}
    ORDER BY gmvPerUser DESC
  `;
  return runQuery_(sql);
}

function getBaseSql_() {
  const table = parseTableId_(BQ_TABLE);
  const schema = BigQuery.Tables.get(table.projectId, table.datasetId, table.tableId).schema.fields || [];
  const cols = {};
  schema.forEach(field => { cols[field.name] = field.type || true; });

  const col = name => cols[name] ? name : `NULL AS ${name}`;
  const stringCol = name => cols[name] ? `CAST(${name} AS STRING) AS ${name}` : `NULL AS ${name}`;
  const stringAlias = (source, target) => cols[source] ? `CAST(${source} AS STRING) AS \`${target}\`` : `NULL AS \`${target}\``;
  const alias = (source, target) => cols[source] ? `${source} AS \`${target}\`` : `NULL AS \`${target}\``;
  const optionalNumber = name => cols[name] ? name : `NULL AS ${name}`;
  const numericAliasFrom = (target, candidates) => {
    const source = candidates.find(name => cols[name]);
    return source ? `${source} AS ${target}` : `NULL AS ${target}`;
  };
  const dateExpr = source => {
    if (!cols[source]) return 'NULL';
    const type = String(cols[source]).toUpperCase();
    if (type === 'DATE') return source;
    if (type === 'DATETIME') return `DATE(${source})`;
    if (type === 'TIMESTAMP') return `DATE(${source}, 'Asia/Jakarta')`;
    return `DATE(${source})`;
  };
  const dateAlias = (source, target) => `${dateExpr(source)} AS ${target}`;
  const dateTickAlias = (source, target) => `${dateExpr(source)} AS \`${target}\``;

  return [
    'SELECT',
    stringCol('device_id') + ',',
    stringCol('device_type') + ',',
    dateAlias('install_date', 'install_date') + ',',
    stringCol('install_channel') + ',',
    dateAlias('register_date', 'register_date') + ',',
    stringCol('register_channel') + ',',
    dateTickAlias('first_transaction_date', '1st_transaction_date') + ',',
    stringAlias('first_trx_channel', '1st_trx_channel') + ',',
    stringAlias('first_trx_adset', '1st_trx_adset') + ',',
    stringCol('store') + ',',
    optionalNumber('num_trx_d30') + ',',
    optionalNumber('num_trx_d31_to_d60') + ',',
    optionalNumber('num_trx_d61_to_d90') + ',',
    alias('num_trx_d90', 'num_trx_d91+') + ',',
    optionalNumber('gmv') + ',',
    optionalNumber('aov') + ',',
    optionalNumber('gm') + ',',
    optionalNumber('nm') + ',',
    optionalNumber('unique_category') + ',',
    optionalNumber('unique_sku') + ',',
    numericAliasFrom('gross_margin_sum', ['gross_margin_sum', 'gross_margin']) + ',',
    numericAliasFrom('gross_revenue_sum', ['gross_revenue_sum', 'gross_revenue']) + ',',
    numericAliasFrom('gross_profit_sum', ['gross_profit_sum', 'gross_profit']) + ',',
    numericAliasFrom('net_revenue_sum', ['net_revenue_sum', 'net_revenue_before_voucher_rebate', 'net_revenue_before_voucher', 'net_revenue']),
    'FROM `' + BQ_TABLE + '`',
  ].join(' ');
}

function baseCte_() {
  return 'WITH base AS (' + getBaseSql_() + ')';
}

function scoredBase_(where) {
  return `(
    SELECT *,
      COALESCE(num_trx_d30, 0) + COALESCE(num_trx_d31_to_d60, 0) + COALESCE(num_trx_d61_to_d90, 0) + COALESCE(\`num_trx_d91+\`, 0) AS total_trx,
      DATE_DIFF((SELECT MAX(d) FROM (
        SELECT MAX(install_date) d FROM base UNION ALL
        SELECT MAX(register_date) d FROM base UNION ALL
        SELECT MAX(\`1st_transaction_date\`) d FROM base
      )), \`1st_transaction_date\`, DAY) AS days_since_first_trx
    FROM base
    WHERE ${where}
  )`;
}

function filterWhere_(filters) {
  filters = filters || {};
  const parts = [
    'device_id IS NOT NULL',
    'install_channel IS NOT NULL',
    'install_date IS NOT NULL',
  ];
  if (filters.dateFrom) parts.push(`install_date >= DATE '${escapeSql_(filters.dateFrom)}'`);
  if (filters.dateTo) parts.push(`install_date <= DATE '${escapeSql_(filters.dateTo)}'`);
  if (filters.deviceTypes && filters.deviceTypes.length) parts.push(`CAST(device_type AS STRING) IN (${sqlStringList_(filters.deviceTypes)})`);
  if (filters.installChannels && filters.installChannels.length) parts.push(`CAST(install_channel AS STRING) IN (${sqlStringList_(filters.installChannels)})`);
  if (filters.stores && filters.stores.length) parts.push(`CAST(store AS STRING) IN (${sqlStringList_(filters.stores)})`);
  return parts.join(' AND ');
}

function scorecardGroupExpr_(group) {
  if (group === 'adset') return '`1st_trx_adset`';
  if (group === 'store') return 'store';
  return '`1st_trx_channel`';
}

function runQuery_(sql) {
  let response = BigQuery.Jobs.query({
    query: sql,
    useLegacySql: false,
    maxResults: 50000,
    timeoutMs: 60000,
  }, BQ_PROJECT_ID);

  if (!response.jobComplete) {
    response = waitForQuery_(response.jobReference.jobId, response.jobReference.location);
  }

  const out = [];
  appendRows_(out, response);
  while (response.pageToken) {
    response = BigQuery.Jobs.getQueryResults(BQ_PROJECT_ID, response.jobReference.jobId, {
      location: response.jobReference.location,
      maxResults: 50000,
      pageToken: response.pageToken,
      timeoutMs: 60000,
    });
    appendRows_(out, response);
  }
  return out;
}

function waitForQuery_(jobId, location) {
  const deadline = Date.now() + 5 * 60 * 1000;
  let response;
  do {
    response = BigQuery.Jobs.getQueryResults(BQ_PROJECT_ID, jobId, {
      location,
      maxResults: 50000,
      timeoutMs: 60000,
    });
    if (response.jobComplete) return response;
    Utilities.sleep(1000);
  } while (Date.now() < deadline);
  throw new Error('BigQuery query did not finish before the Apps Script timeout.');
}

function appendRows_(target, response) {
  const fields = (response.schema && response.schema.fields || []).map(field => field.name);
  (response.rows || []).forEach(row => {
    const out = {};
    fields.forEach((name, index) => {
      out[name] = row.f[index] ? row.f[index].v : null;
    });
    target.push(out);
  });
}

function parsePayload_(payload) {
  if (!payload) return {};
  try {
    return JSON.parse(payload);
  } catch (err) {
    throw new Error('Invalid payload JSON.');
  }
}

function json_(data, statusCode) {
  const output = ContentService
    .createTextOutput(JSON.stringify(data))
    .setMimeType(ContentService.MimeType.JSON);
  // Apps Script ContentService cannot set HTTP status codes or CORS headers.
  return output;
}

function firstRow_(rows) {
  return rows && rows.length ? rows[0] : null;
}

function sqlStringList_(values) {
  return values.map(v => `'${escapeSql_(v)}'`).join(', ');
}

function escapeSql_(value) {
  return String(value).replace(/'/g, "''");
}

function parseTableId_(tableId) {
  const parts = tableId.split('.');
  if (parts.length !== 3) throw new Error('BQ_TABLE must be project.dataset.table');
  return { projectId: parts[0], datasetId: parts[1], tableId: parts[2] };
}
