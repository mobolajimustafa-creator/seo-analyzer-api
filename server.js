// server.js
require('dotenv').config();
const express = require('express');
const cors = require('cors');
const axios = require('axios');
const OpenAI = require('openai'); // Initialize OpenAI client

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

// --- DataForSEO Helper Functions ---

// Helper: construct Basic Authorization header (from DataForSEO chatbot)
function getDataForSeoAuthHeader() {
  const login = process.env.DATAFORSEO_LOGIN;
  const password = process.env.DATAFORSEO_PASSWORD;

  if (login && password) {
    const cred = Buffer.from(`${login}:${password}`).toString('base64');
    return `Basic ${cred}`;
  }

  if (process.env.DATAFORSEO_API_AUTH) {
    return `Basic ${process.env.DATAFORSEO_API_AUTH}`;
  }

  throw new Error('Missing DataForSEO credentials. Set DATAFORSEO_LOGIN & DATAFORSEO_PASSWORD or DATAFORSEO_API_AUTH in .env');
}

// Generic caller with retries and exponential backoff (from DataForSEO chatbot)
async function callDataForSeo(endpointPath, tasksArray = [], opts = {}) {
  const url = `${DATAFORSEO_URL}/${endpointPath.replace(/^\/+/, '')}`;
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
      // Check for DataForSEO status code 20000 (success)
      if (response.data.status_code !== 20000) {
          const errorToThrow = new Error(`DataForSEO API Error: ${response.data.status_code} - ${response.data.status_message}`);
          errorToThrow.serverData = response.data;
          throw errorToThrow;
      }
      return response.data;
    } catch (err) {
      lastErr = err;
      const serverData = err.response?.data || err.serverData; // Check original error structure
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

// --- Routes ---

// Health check
app.get('/status', (req, res) => {
  res.json({ message: 'SEO Platform API is running!' });
});

// Core SEO Analysis Route (Integrated Logic)
app.post('/api/seo-analysis', async (req, res) => {
  const { domain, keyword, target_country, location_code = 2840, language_code = 'en' } = req.body;

  if (!domain || !keyword) {
    return res.status(400).json({ error: 'Domain and keyword are required.' });
  }

  try {
    // A. FETCH DATA from DataForSEO using the new helper
    const task = { keyword, language_code, location_code };
    const dataForSEOResponse = await callDataForSeo('serp/google/organic/live/advanced', [task], { retries: 3 });

// server.js - Find and replace the Data Extraction section:

// B. EXTRACT SERP DATA (The slightly refined logic)
const resultTask = dataForSEOResponse.tasks[0];
let serpData = [];

if (resultTask && resultTask.result) {
    // Collect all items from the result array, prioritizing 'organic' but including all
    const allItems = [];
    
    resultTask.result.forEach(resultItem => {
        if (Array.isArray(resultItem.items)) {
            // Find the organic result item and set serpData to its items
            if (resultItem.item_type === 'organic') {
                serpData = resultItem.items; // Use this to ensure it gets the organic list
            }
            // If the organic list is found, we stop here.
        }
    });

    // Fallback: If serpData is still empty, look for any top-level item lists
    if (serpData.length === 0) {
        const topLevelItems = resultTask.result.find(r => Array.isArray(r.items) && r.items.length > 0);
        if (topLevelItems) {
             serpData = topLevelItems.items;
        }
    }
} 
// Note: If the AI mentioned a "featured snippet," that data was passed, 
// so the problem is purely in how 'serpData' is ultimately set for the final response.

// C. ANALYZE DATA with OpenAI (This part remains the same)
// ...

    // C. ANALYZE DATA with OpenAI
    const dataSummary = JSON.stringify(serpData.slice(0, 5), null, 2); 
    
    const competitorDataMessage = serpData.length > 0 
        ? `The top competitor data is: ${dataSummary}.`
        : `No competitor data was found in the SERP results. Provide general, foundational SEO advice for this keyword.`;

    const prompt = `Analyze the following SERP data for the keyword "${keyword}" in the domain "${domain}".
    ${competitorDataMessage}
    
    Provide a brief, actionable SEO strategy for this website (${domain}) to rank higher.
    The output should be a single, professional paragraph.`;

    const aiResponse = await openai.completions.create({
      model: 'gpt-3.5-turbo-instruct', 
      prompt: prompt,
      max_tokens: 300, 
    });

    const analysis = aiResponse.choices[0].text.trim();

    // D. RETURN FINAL RESULT
    res.json({
      success: true,
      domain: domain,
      keyword: keyword,
      analysis: analysis,
      raw_data_snippet: serpData.slice(0, 5) // Will now contain data if successful
    });

  } catch (error) {
    console.error("API Processing Error:", error.serverData || error.message || error);
    res.status(500).json({ 
      success: false, 
      error: 'Failed to process SEO analysis.',
      details: error.serverData || error.message // Use error.serverData for specific DataForSEO errors
    });
  }
});

// Start server
app.listen(PORT, () => {
  console.log(`Server running on http://localhost:${PORT}`);
});