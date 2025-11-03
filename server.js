// server.js

// 1. Setup Dependencies and Environment
require('dotenv').config();
const express = require('express');
const cors = require('cors');
const axios = require('axios');
const OpenAI = require('openai'); // Use the official SDK

const app = express();
const PORT = process.env.PORT || 3000;
const DATAFORSEO_URL = 'https://api.dataforseo.com/v3/'; // Example base URL

// 2. Middleware
// Allow JSON body parsing
app.use(express.json()); 

// Configure CORS for your WordPress site
const corsOptions = {
  origin: process.env.WORDPRESS_URL,
  optionsSuccessStatus: 200 // For legacy browser support
};
app.use(cors(corsOptions));

// Initialize OpenAI Client
const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY,
});

// 3. Health Check Route
app.get('/status', (req, res) => {
  res.json({ message: 'SEO Platform API is running!' });
});

// 4. Core SEO Analysis Route
app.post('/api/seo-analysis', async (req, res) => {
  const { domain, keyword, target_country } = req.body;

  if (!domain || !keyword) {
    return res.status(400).json({ error: 'Domain and keyword are required.' });
  }

  try {
    // ------------------------------------------------------------------
    // A. FETCH DATA from DataForSEO
    // ------------------------------------------------------------------
    // NOTE: This is a placeholder. DataForSEO APIs often require a two-step 
    // process: setting a task, then polling/receiving a webhook for results.
    // We are simulating a direct, synchronous call for simplicity.
    
    // Example: Fetch SERP results for a keyword
    const dataForSEOResponse = await axios.post(
      `${DATAFORSEO_URL}/serp/google/organic/live/advanced`, 
      [{
        language_code: "en",
        location_code: 2840, // Example: New York, USA
        keyword: keyword
      }],
      {
        headers: {
            'Authorization': 'Basic ' + process.env.DATAFORSEO_API_AUTH,
            'Content-Type': 'application/json'
        }
      }
    );

    const serpData = dataForSEOResponse.data.tasks[0].result;
    
    // ------------------------------------------------------------------
    // B. ANALYZE DATA with OpenAI
    // ------------------------------------------------------------------
    
    // Create a concise text summary of the raw data to send to the AI
    const dataSummary = JSON.stringify(serpData.slice(0, 5), null, 2); // Send top 5 results
    
    const prompt = `Analyze the following SERP data for the keyword "${keyword}" in the domain "${domain}".
    The top competitor data is: ${dataSummary}.
    
    Provide a brief, actionable SEO strategy for this website (${domain}) to rank higher.
    The output should be a single, professional paragraph.`;

    const aiResponse = await openai.completions.create({
      model: 'gpt-3.5-turbo-instruct', 
      prompt: prompt,
      max_tokens: 300, 
    });

    const analysis = aiResponse.choices[0].text.trim();

    // ------------------------------------------------------------------
    // C. RETURN FINAL RESULT
    // ------------------------------------------------------------------
    res.json({
      success: true,
      domain: domain,
      keyword: keyword,
      analysis: analysis,
      raw_data_snippet: serpData.slice(0, 5) // Optional: include some raw data for debugging/display
    });

  } catch (error) {
    console.error("API Processing Error:", error.message);
    res.status(500).json({ 
      success: false, 
      error: 'Failed to process SEO analysis.',
      details: error.message 
    });
  }
});

// 5. Start Server
app.listen(PORT, () => {
  console.log(`Server running on http://localhost:${PORT}`);
});