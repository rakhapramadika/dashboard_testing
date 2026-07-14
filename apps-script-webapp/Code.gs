const BQ_PROJECT_ID = 'tri-omnichannel-prd';
const BQ_TABLE = 'tri-omnichannel-prd.claude.allofresh_users_quality_v2';
const APP_VERSION = 'pwa-proxy-v3-tabs';
const CACHE_TIMEZONE = 'Asia/Jakarta';
const CACHE_ROLLOVER_HOUR = 9;
const CACHE_SERVICE_SECONDS = 21600;
const CACHE_PROPERTY_CHUNK_SIZE = 8000;
const CACHE_BUSTER_KEY = 'dashboard_cache_buster';

function clearDashboardCache() {
  const props = PropertiesService.getScriptProperties();
  const all = props.getProperties();
  Object.keys(all)
    .filter(key => key.indexOf('dt_') === 0)
    .forEach(key => props.deleteProperty(key));
  props.setProperty(CACHE_BUSTER_KEY, String(Date.now()));
  return true;
}

function doGet() {
  return HtmlService
    .createTemplateFromFile('Index')
    .evaluate()
    .setTitle('Allofresh Dashboard')
    .setXFrameOptionsMode(HtmlService.XFrameOptionsMode.ALLOWALL);
}

function include(filename) {
  return HtmlService.createHtmlOutputFromFile(filename).getContent();
}

function apiCall(action, payload) {
  payload = payload || {};
  try {
    if (action === 'dashboard') {
      return getDashboardBundle(payload.filters || {}, payload.group || 'channel', payload.minUsers || 50);
    }
    if (action === 'metadata') {
      return getDashboardMetadata();
    }
    if (action === 'scorecard') {
      return getScorecardSummary(payload.filters || {}, payload.group || 'channel', payload.minUsers || 50);
    }
    if (action === 'conversion') {
      return getConversionSummary(payload.filters || {});
    }
    if (action === 'retention') {
      return getRetentionSummary(payload.filters || {}, payload.group || 'channel', payload.adsetChannel || '');
    }
    if (action === 'geo') {
      return getGeoSummary(payload.filters || {}, payload.basis || '1st_trx_channel', payload.channels || [], payload.adsets || []);
    }
    throw new Error('Unknown action: ' + action);
  } catch (err) {
    throw new Error(String(err && err.message ? err.message : err));
  }
}

function getDashboardBundle(filters, group, minUsers) {
  return {
    metadata: sectionResult_(() => getDashboardMetadata()),
    scorecard: sectionResult_(() => getScorecardSummary(filters, group, minUsers)),
    conversion: sectionResult_(() => getConversionSummary(filters)),
    retention: sectionResult_(() => getRetentionSummary(filters, 'channel', '')),
    geo: sectionResult_(() => getGeoSummary(filters, '1st_trx_channel', [], [])),
  };
}

function sectionResult_(producer) {
  try {
    return { ok: true, data: producer() };
  } catch (err) {
    return { ok: false, error: String(err && err.message ? err.message : err) };
  }
}
function getDashboardMetadata() {
  return dailyCached_('metadata', {}, () => {
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
  });
}

function getScorecardSummary(filters, group, minUsers) {
  const cacheParams = {
    filters: normalizedFilters_(filters),
    group: group || 'channel',
    minUsers: Math.max(0, Number(minUsers || 50)),
  };
  return dailyCached_('scorecard', cacheParams, () => {
    const groupExpr = scorecardGroupExpr_(group);
    const minN = cacheParams.minUsers;
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
  });
}

function getConversionSummary(filters) {
  const cacheParams = { filters: normalizedFilters_(filters) };
  return dailyCached_('conversion', cacheParams, () => {
    const sql = baseCte_() + `,
      filtered AS (
        SELECT *,
          IF(register_date IS NOT NULL AND register_channel IS NOT NULL, TRUE, FALSE) AS is_reg,
          IF(\`1st_transaction_date\` IS NOT NULL AND \`1st_trx_channel\` IS NOT NULL, TRUE, FALSE) AS is_trx,
          LOWER(CAST(uninstall_flag AS STRING)) IN ('yes', 'true', '1') AS is_uninst,
          DATE_DIFF((SELECT MAX(d) FROM (
            SELECT MAX(install_date) d FROM base UNION ALL
            SELECT MAX(register_date) d FROM base UNION ALL
            SELECT MAX(\`1st_transaction_date\`) d FROM base UNION ALL
            SELECT MAX(uninstall_date) d FROM base
          )), \`1st_transaction_date\`, DAY) AS days_since_first_trx,
          COALESCE(num_trx_d31_to_d60, 0) + COALESCE(num_trx_d61_to_d90, 0) + COALESCE(\`num_trx_d91+\`, 0) AS after30
        FROM base
        WHERE ${filterWhere_(filters)}
      ),
      by_channel AS (
        SELECT
          install_channel AS channel,
          COUNT(*) installs,
          SUM(IF(is_reg, 1, 0)) registered,
          SUM(IF(is_trx, 1, 0)) transacted,
          SUM(IF(is_uninst, 1, 0)) uninstalled,
          SUM(IF(days_since_first_trx >= 60 AND after30 >= 1, 1, 0)) repeat30,
          SUM(IF(days_since_first_trx >= 60, 1, 0)) mature30
        FROM filtered
        GROUP BY install_channel
      )
      SELECT
        channel,
        installs,
        registered,
        transacted,
        uninstalled,
        repeat30,
        mature30,
        SAFE_DIVIDE(registered, NULLIF(installs, 0)) AS registerRate,
        SAFE_DIVIDE(transacted, NULLIF(installs, 0)) AS transactionRate,
        SAFE_DIVIDE(repeat30, NULLIF(mature30, 0)) AS repeatRate
      FROM by_channel
      WHERE channel IS NOT NULL AND channel != ''
      ORDER BY installs DESC
    `;
    return runQuery_(sql);
  });
}

function getRetentionSummary(filters, groupBy, adsetChannel) {
  const cacheParams = {
    filters: normalizedFilters_(filters),
    groupBy: groupBy || 'channel',
    adsetChannel: adsetChannel || '',
  };
  return dailyCached_('retention', cacheParams, () => {
    const groupExpr = retentionGroupExpr_(groupBy);
    const adsetFilter = adsetChannel ? "AND `1st_trx_channel` = '" + escapeSql_(adsetChannel) + "'" : '';
    const sql = baseCte_() + `,
      filtered AS (
        SELECT *,
          DATE_DIFF((SELECT MAX(d) FROM (
            SELECT MAX(install_date) d FROM base UNION ALL
            SELECT MAX(register_date) d FROM base UNION ALL
            SELECT MAX(\`1st_transaction_date\`) d FROM base UNION ALL
            SELECT MAX(uninstall_date) d FROM base
          )), \`1st_transaction_date\`, DAY) AS days_since_first_trx
        FROM base
        WHERE ${filterWhere_(filters)}
          AND \`1st_transaction_date\` IS NOT NULL
          ${adsetFilter}
      )
      SELECT
        ${groupExpr} AS groupKey,
        SUBSTR(CAST(\`1st_transaction_date\` AS STRING), 1, 7) AS cohortMonth,
        COUNT(*) AS n,
        SUM(IF(COALESCE(num_trx_d30, 0) >= 1, 1, 0)) AS d30,
        SUM(IF(days_since_first_trx >= 60, 1, 0)) AS m60,
        SUM(IF(days_since_first_trx >= 60 AND COALESCE(num_trx_d31_to_d60, 0) >= 1, 1, 0)) AS r60,
        SUM(IF(days_since_first_trx >= 90, 1, 0)) AS m90,
        SUM(IF(days_since_first_trx >= 90 AND COALESCE(num_trx_d61_to_d90, 0) >= 1, 1, 0)) AS r90,
        SUM(IF(days_since_first_trx >= 91, 1, 0)) AS m91,
        SUM(IF(days_since_first_trx >= 91 AND COALESCE(\`num_trx_d91+\`, 0) >= 1, 1, 0)) AS r91
      FROM filtered
      WHERE ${groupExpr} IS NOT NULL AND ${groupExpr} != ''
      GROUP BY groupKey, cohortMonth
      ORDER BY groupKey, cohortMonth
    `;
    return runQuery_(sql);
  });
}

function getGeoSummary(filters, basis, selectedChannels, selectedAdsets) {
  const cacheParams = {
    filters: normalizedFilters_(filters),
    basis: basis || '1st_trx_channel',
    channels: normalizedList_(selectedChannels),
    adsets: normalizedList_(selectedAdsets),
  };
  return dailyCached_('geo', cacheParams, () => {
    const basisCol = geoBasisColumn_(basis);
    const channelWhere = selectedChannels && selectedChannels.length
      ? `${basisCol} IN (${sqlStringList_(selectedChannels)})`
      : 'TRUE';
    const adsetWhere = selectedAdsets && selectedAdsets.length
      ? `\`1st_trx_adset\` IN (${sqlStringList_(selectedAdsets)})`
      : 'TRUE';
    const sql = baseCte_() + `,
      filtered AS (
        SELECT *,
          CASE
            WHEN \`1st_transaction_date\` IS NOT NULL THEN 'transacted'
            WHEN register_date IS NOT NULL THEN 'register_only'
            ELSE 'install_only'
          END AS funnelStage
        FROM base
        WHERE ${filterWhere_(filters)}
      ),
      point_sample AS (
        SELECT
          'point' AS rowType,
          CAST(latitude AS FLOAT64) AS latitude,
          CAST(longitude AS FLOAT64) AS longitude,
          CAST(${basisCol} AS STRING) AS channel,
          store,
          CAST(gmv AS FLOAT64) AS gmv,
          CAST(NULL AS INT64) users,
          CAST(NULL AS INT64) withCoords,
          CAST(NULL AS FLOAT64) totalGmv,
          CAST(NULL AS STRING) byStage,
          CAST(NULL AS STRING) byChannel,
          CAST(NULL AS FLOAT64) store_latitude,
          CAST(NULL AS FLOAT64) store_longitude,
          CAST(NULL AS FLOAT64) store_radius
        FROM filtered
        WHERE ${channelWhere}
          AND ${adsetWhere}
          AND latitude IS NOT NULL
          AND longitude IS NOT NULL
          AND \`1st_transaction_date\` IS NOT NULL
        QUALIFY ROW_NUMBER() OVER (ORDER BY FARM_FINGERPRINT(CAST(device_id AS STRING))) <= 1000
      ),
      store_totals AS (
        SELECT
          store,
          COUNT(*) users,
          SUM(IF(latitude IS NOT NULL AND longitude IS NOT NULL, 1, 0)) withCoords,
          CAST(SUM(gmv) AS FLOAT64) totalGmv,
          CAST(ANY_VALUE(store_latitude) AS FLOAT64) store_latitude,
          CAST(ANY_VALUE(store_longitude) AS FLOAT64) store_longitude,
          CAST(ANY_VALUE(store_radius) AS FLOAT64) store_radius
        FROM filtered
        WHERE store IS NOT NULL
        GROUP BY store
      ),
      store_layer AS (
        SELECT
          'store' AS rowType,
          CAST(NULL AS FLOAT64) latitude,
          CAST(NULL AS FLOAT64) longitude,
          CAST(NULL AS STRING) channel,
          store,
          CAST(NULL AS FLOAT64) gmv,
          users,
          withCoords,
          totalGmv,
          CAST(NULL AS STRING) byStage,
          CAST(NULL AS STRING) byChannel,
          store_latitude,
          store_longitude,
          store_radius
        FROM store_totals
      )
      SELECT * FROM point_sample
      UNION ALL
      SELECT * FROM store_layer
    `;
    return runQuery_(sql);
  });
}

function getBaseSql_() {
  const cols = getSchemaColumns_();

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
    dateAlias('uninstall_date', 'uninstall_date') + ',',
    col('uninstall_flag') + ',',
    stringCol('store') + ',',
    col('latitude') + ',',
    col('longitude') + ',',
    col('store_latitude') + ',',
    col('store_longitude') + ',',
    col('store_radius') + ',',
    optionalNumber('num_trx_d30') + ',',
    optionalNumber('num_trx_d31_to_d60') + ',',
    optionalNumber('num_trx_d61_to_d90') + ',',
    alias('num_trx_d90', 'num_trx_d91+') + ',',
    optionalNumber('gmv_d30') + ',',
    optionalNumber('gmv_d31_to_d60') + ',',
    optionalNumber('gmv_d61_to_d90') + ',',
    alias('gmv_d90', 'gmv_d90+') + ',',
    optionalNumber('gmv') + ',',
    optionalNumber('aov') + ',',
    optionalNumber('gm') + ',',
    optionalNumber('nm') + ',',
    optionalNumber('unique_category') + ',',
    optionalNumber('unique_sku') + ',',
    optionalNumber('gmv_sembako') + ',',
    optionalNumber('gmv_fruits_vege') + ',',
    optionalNumber('gmv_butchery') + ',',
    optionalNumber('gmv_fishery') + ',',
    optionalNumber('gmv_beverage') + ',',
    optionalNumber('gmv_cleaning') + ',',
    optionalNumber('gmv_cosmetics') + ',',
    optionalNumber('gmv_other_dry_grocery') + ',',
    optionalNumber('gmv_self_service_perishable') + ',',
    optionalNumber('gmv_others') + ',',
    numericAliasFrom('gross_margin_sum', ['gross_margin_sum', 'gross_margin']) + ',',
    numericAliasFrom('gross_revenue_sum', ['gross_revenue_sum', 'gross_revenue']) + ',',
    numericAliasFrom('gross_profit_sum', ['gross_profit_sum', 'gross_profit']) + ',',
    numericAliasFrom('net_revenue_sum', ['net_revenue_sum', 'net_revenue_before_voucher_rebate', 'net_revenue_before_voucher', 'net_revenue']),
    'FROM `' + BQ_TABLE + '`',
  ].join(' ');
}

function getSchemaColumns_() {
  return dailyCached_('schema', { table: BQ_TABLE }, () => {
    const table = parseTableId_(BQ_TABLE);
    const schema = BigQuery.Tables.get(table.projectId, table.datasetId, table.tableId).schema.fields || [];
    const cols = {};
    schema.forEach(field => { cols[field.name] = field.type || true; });
    return cols;
  });
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

function retentionGroupExpr_(groupBy) {
  if (groupBy === 'device') return 'device_type';
  if (groupBy === 'adset') return '`1st_trx_adset`';
  return '`1st_trx_channel`';
}

function geoBasisColumn_(basis) {
  if (basis === 'install_channel') return 'install_channel';
  if (basis === 'register_channel') return 'register_channel';
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

function json_(data, callback) {
  if (callback) {
    if (!/^[A-Za-z_$][0-9A-Za-z_$]*(\.[A-Za-z_$][0-9A-Za-z_$]*)*$/.test(callback)) {
      throw new Error('Invalid JSONP callback.');
    }
    return ContentService
      .createTextOutput(callback + '(' + JSON.stringify(data) + ');')
      .setMimeType(ContentService.MimeType.JAVASCRIPT);
  }

  return ContentService
    .createTextOutput(JSON.stringify(data))
    .setMimeType(ContentService.MimeType.JSON);
}

function firstRow_(rows) {
  return rows && rows.length ? rows[0] : null;
}

function dailyCached_(name, params, producer) {
  const key = cacheKey_(name, params);
  const scriptCache = CacheService.getScriptCache();
  const cached = parseCachePayload_(scriptCache.get(key));
  if (cached.hit) return cached.data;

  const persisted = getPersistentCache_(key);
  if (persisted.hit) {
    putScriptCache_(scriptCache, key, persisted.data);
    return persisted.data;
  }

  const data = producer();
  const payload = { expiresAt: Date.now() + 30 * 60 * 60 * 1000, data };
  const json = JSON.stringify(payload);
  putScriptCache_(scriptCache, key, data);
  putPersistentCache_(key, json);
  return data;
}

function putScriptCache_(scriptCache, key, data) {
  try {
    scriptCache.put(key, JSON.stringify({ data }), CACHE_SERVICE_SECONDS);
  } catch (err) {
    // CacheService has a small value limit. Persistent chunked cache can still handle this.
  }
}

function cacheKey_(name, params) {
  const raw = [
    APP_VERSION,
    getCacheBuster_(),
    dailyCacheBucket_(),
    name,
    stableStringify_(params || {}),
  ].join('|');
  return 'dt_' + hash_(raw);
}

function getCacheBuster_() {
  return PropertiesService.getScriptProperties().getProperty(CACHE_BUSTER_KEY) || '0';
}

function dailyCacheBucket_() {
  const shifted = new Date(Date.now() - CACHE_ROLLOVER_HOUR * 60 * 60 * 1000);
  return Utilities.formatDate(shifted, CACHE_TIMEZONE, 'yyyyMMdd');
}

function parseCachePayload_(value) {
  if (!value) return { hit: false };
  try {
    const parsed = JSON.parse(value);
    return { hit: true, data: parsed.data };
  } catch (err) {
    return { hit: false };
  }
}

function getPersistentCache_(key) {
  try {
    const props = PropertiesService.getScriptProperties();
    const indexRaw = props.getProperty(key + '_index');
    if (!indexRaw) return { hit: false };

    const index = JSON.parse(indexRaw);
    if (!index || Number(index.expiresAt || 0) <= Date.now()) return { hit: false };

    const chunks = [];
    for (let i = 0; i < Number(index.chunks || 0); i++) {
      const chunk = props.getProperty(key + '_' + i);
      if (chunk === null) return { hit: false };
      chunks.push(chunk);
    }

    const payload = JSON.parse(chunks.join(''));
    if (Number(payload.expiresAt || 0) <= Date.now()) return { hit: false };
    return { hit: true, data: payload.data };
  } catch (err) {
    return { hit: false };
  }
}

function putPersistentCache_(key, json) {
  try {
    const props = PropertiesService.getScriptProperties();
    const oldIndexRaw = props.getProperty(key + '_index');
    if (oldIndexRaw) {
      const oldIndex = JSON.parse(oldIndexRaw);
      const deleteKeys = [key + '_index'];
      for (let i = 0; i < Number(oldIndex.chunks || 0); i++) deleteKeys.push(key + '_' + i);
      deleteKeys.forEach(deleteKey => props.deleteProperty(deleteKey));
    }

    const values = {};
    const chunks = Math.ceil(json.length / CACHE_PROPERTY_CHUNK_SIZE);
    for (let i = 0; i < chunks; i++) {
      values[key + '_' + i] = json.slice(i * CACHE_PROPERTY_CHUNK_SIZE, (i + 1) * CACHE_PROPERTY_CHUNK_SIZE);
    }
    values[key + '_index'] = JSON.stringify({ expiresAt: Date.now() + 30 * 60 * 60 * 1000, chunks });
    props.setProperties(values);
  } catch (err) {
    // Cache writes are best effort; BigQuery results should still be returned.
  }
}

function stableStringify_(value) {
  if (Array.isArray(value)) return '[' + value.map(stableStringify_).join(',') + ']';
  if (value && typeof value === 'object') {
    return '{' + Object.keys(value).sort().map(key => JSON.stringify(key) + ':' + stableStringify_(value[key])).join(',') + '}';
  }
  return JSON.stringify(value);
}

function normalizedFilters_(filters) {
  filters = filters || {};
  return {
    dateFrom: filters.dateFrom || '',
    dateTo: filters.dateTo || '',
    deviceTypes: normalizedList_(filters.deviceTypes),
    installChannels: normalizedList_(filters.installChannels),
    stores: normalizedList_(filters.stores),
  };
}

function normalizedList_(values) {
  return (values || []).map(String).filter(Boolean).sort();
}

function hash_(value) {
  const bytes = Utilities.computeDigest(Utilities.DigestAlgorithm.SHA_256, value);
  return Utilities.base64EncodeWebSafe(bytes).replace(/=+$/, '').slice(0, 40);
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
