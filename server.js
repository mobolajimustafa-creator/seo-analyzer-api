// server.js
require('dotenv').config();
const express = require('express');
const cors = require('cors');
const axios = require('axios');
const OpenAI = require('openai');

const app = express();
const PORT = process.env.PORT || 3000;
const DATAFORSEO_URL = process.env.DATAFORSEO_URL || 'https://api.dataforseo.com/v3';

// Initialize OpenAI Client
const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY,
});

// Middleware
app.use(express.json());
app.use(cors({
  origin: process.env.WORDPRESS_URL || '*',
  optionsSuccessStatus: 200
}));

// --- Helpers ---

// Build Basic Authorization header.
// Supports either DATAFORSEO_LOGIN/DATAFORSEO_PASSWORD or precomputed DATAFORSEO_API_AUTH (base64).
function getDataForSeoAuthHeader() {
  const login = process.env.DATAFORSEO_LOGIN;
  const password = process.env.DATAFORSEO_PASSWORD;
  const precomputed = process.env.DATAFORSEO_API_AUTH;

  if (login && password) {
    const cred = Buffer.from(`${login}:${password}`).toString('base64');
    return `Basic ${cred}`;
  }

  if (precomputed) {
    // Allow users to store either the raw base64 or the complete "Basic ..." value.
    const cleaned = precomputed.replace(/^(Basic\s*)/i, '');
    return `Basic ${cleaned}`;
  }

  throw new Error('Missing DataForSEO credentials. Set DATAFORSEO_LOGIN & DATAFORSEO_PASSWORD or DATAFORSEO_API_AUTH in env.');
}

// Call DataForSEO with retries and exponential backoff
async function callDataForSeo(endpointPath, tasksArray = [], opts = {}) {
  const url = `${DATAFORSEO_URL.replace(/\/+$/, '')}/${endpointPath.replace(/^\/+/, '')}`;
  const body = { tasks: tasksArray };
  const headers = {
    Authorization: getDataForSeoAuthHeader(),
    'Content-Type': 'application/json'
  };

  const maxAttempts = opts.retries || 3;
  const baseDelay = opts.baseDelayMs || 500;
  let lastErr;

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      const response = await axios.post(url, body, { headers, timeout: opts.timeout || 30000 });

      // DataForSEO top-level status check
      if (response.data && response.data.status_code && response.data.status_code !== 20000) {
        const err = new Error(`DataForSEO API Error: ${response.data.status_code} - ${response.data.status_message}`);
        err.serverData = response.data;
        throw err;
      }

      return response.data;
    } catch (err) {
      lastErr = err;
      const serverData = err.response?.data || err.serverData;
      console.warn(`DataForSEO request error (attempt ${attempt}):`, serverData || err.message);

      if (attempt === maxAttempts) {
        const errorToThrow = new Error('DataForSEO request failed after retries: ' + (err.message || 'unknown'));
        errorToThrow.original = err;
        errorToThrow.serverData = serverData;
        throw errorToThrow;
      }

      const delay = baseDelay * Math.pow(2, attempt - 1);
      await new Promise(r => setTimeout(r, delay));
    }
  }

  throw lastErr || new Error('Unexpected error in callDataForSeo');
}

// Defensive extractor for organic items (handles nested structures & fallbacks)
function extractOrganicItemsFromDfResponse(dfData) {
  if (!dfData || !Array.isArray(dfData.tasks) || dfData.tasks.length === 0) return [];

  const task = dfData.tasks[0];
  console.log('DataForSEO top-level status:', { status_code: dfData.status_code, status_message: dfData.status_message });
  console.log('DataForSEO task status:', { status_code: task.status_code, status_message: task.status_message });

  const resultObj = Array.isArray(task.result) && task.result.length > 0 ? task.result[0] : null;
  if (!resultObj) {
    console.warn('No result object in DataForSEO task.');
    return [];
  }

  // Primary items list
  let items = Array.isArray(resultObj.items) ? resultObj.items.slice() : [];

  // Some items might themselves have nested items arrays (carousels, multi_carousel, etc.)
  const nestedItems = items.flatMap(it => (it && Array.isArray(it.items) ? it.items : []));
  if (nestedItems.length > 0) items = items.concat(nestedItems);

  // Try to detect organic by multiple possible markers:
  // - item.type === 'organic'
  // - item.item_type === 'organic'
  // - item.item_types array includes 'organic'
  const organic = items.filter(it => {
    if (!it || typeof it !== 'object') return false;
    if (it.type === 'organic') return true;
    if (it.item_type === 'organic') return true;
    if (Array.isArray(it.item_types) && it.item_types.includes('organic')) return true;
    return false;
  });

  // If organic found, return it. Otherwise return all items as a fallback so AI still receives context.
  return organic.length > 0 ? organic : items;
}

// --- Routes ---

// Health check
app.get('/status', (req, res) => {
  res.json({ message: 'SEO Platform API is running!' });
});

// Core SEO Analysis Route
app.post('/api/seo-analysis', async (req, res) => {
  const {
    domain,
    keyword,
    target_country,
    location_code = 2840,
    language_code = 'en',
    device = 'desktop'
  } = req.body || {};

  if (!domain || !keyword) {
    return res.status(400).json({ error: 'Domain and keyword are required.' });
  }

  try {
    // A. FETCH DATA from DataForSEO
    const taskPayload = {
      keyword,
      location_code,
      language_code,
      device,
      calculate_rectangles: false,
    // --- ADDED FIELDS TO FIX 40503 ERROR ---
      api: 'serp',
      function: 'live',
      se: 'google',
      se_type: 'organic'
    // ----------------------------------------
    };

    const dataForSEOResponse = await callDataForSeo('serp/google/organic/live/advanced', [taskPayload], { retries: 3 });

    // Log some diagnostics for Render logs
    console.log('DataForSEO response version/time/cost:', {
      version: dataForSEOResponse.version,
      time: dataForSEOResponse.time,
      cost: dataForSEOResponse.cost
    });

    // B. EXTRACT SERP DATA
    const serpData = extractOrganicItemsFromDfResponse(dataForSEOResponse);
    console.log('Extracted serpData count:', serpData.length);

    // Limit items we send to AI for prompt size (but keep originals in logs if needed)
    const serpDataForAI = serpData.slice(0, 8);
    const dataSummary = serpDataForAI.length > 0 ? JSON.stringify(serpDataForAI, null, 2) : 'No structured SERP item data available.';

    // C. ANALYZE DATA with OpenAI
    const competitorDataMessage = serpDataForAI.length > 0
      ? `The top competitor data is: ${dataSummary}`
      : `No competitor data was found in the SERP results. Provide general, foundational SEO advice for this keyword.`;

    const prompt = `Analyze the following SERP data for the keyword "${keyword}" in the domain "${domain}".
${competitorDataMessage}

Provide a brief, actionable SEO strategy for this website (${domain}) to rank higher.
The output should be a single, professional paragraph.`;

    // Use the OpenAI completions endpoint method you already use in production.
    // If you use a different SDK signature, adapt this call accordingly.
    const aiResponse = await openai.completions.create({
      model: process.env.OPENAI_MODEL || 'gpt-3.5-turbo-instruct',
      prompt,
      max_tokens: 300,
    });

    const analysis = aiResponse?.choices?.[0]?.text?.trim?.() || '';

    // D. RETURN FINAL SINGLE RESPONSE
    return res.status(200).json({
      success: true,
      domain,
      keyword,
      analysis,
      raw_data_snippet: serpData.slice(0, 5), // trimmed payload for client
      df_status: {
        top: dataForSEOResponse.status_code ? { status_code: dataForSEOResponse.status_code, status_message: dataForSEOResponse.status_message } : null,
        task: dataForSEOResponse.tasks?.[0] ? { status_code: dataForSEOResponse.tasks[0].status_code, status_message: dataForSEOResponse.tasks[0].status_message } : null
      }
    });

  } catch (error) {
    // Provide logs for debugging; include DataForSEO serverData if present
    console.error("API Processing Error:", error.serverData || error.response?.data || error.message || error);
    return res.status(500).json({
      success: false,
      error: 'Failed to process SEO analysis.',
      details: error.serverData || error.response?.data || error.message
    });
  }
});

// Start server
app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});

// server.js — debug snippet (insert after receiving dataForSEOResponse)
console.log('DataForSEO full response.tasks[0]:', JSON.stringify(dataForSEOResponse.tasks?.[0], null, 2));

