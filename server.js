// server.js

// 1. Setup Dependencies and Environment
require('dotenv').config();
const express = require('express');
const cors = require('cors');
const axios = require('axios');
const OpenAI = require('openai'); // Use the official SDK

const app = express();
const PORT = process.env.PORT || 3000;
const DATAFORSEO_URL = 'https://api.dataforseo.com/v3'; // Example base URL

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

    // --- FIX/IMPROVEMENT: Check for top-level DataForSEO errors ---
    const responseData = dataForSEOResponse.data;

    if (responseData.status_code !== 20000) {
        console.error("DataForSEO API Error:", responseData.status_message, responseData.status_code);
        // Throw an error to be caught by the outer catch block
        throw new Error(`DataForSEO API Error: ${responseData.status_code} - ${responseData.status_message}`);
    }

    // Check for successful task creation and get the first task object
    // Guard against empty tasks array
    if (!responseData.tasks || responseData.tasks.length === 0) {
        console.warn("DataForSEO returned a successful status but zero tasks. Check request parameters.");
        // Continue, but serpData will be empty, which is handled below.
    }
    
    const task = responseData.tasks ? responseData.tasks[0] : null;

    // ------------------------------------------------------------------
    // B. EXTRACT SERP DATA (The Corrected Robust Logic)
    // ------------------------------------------------------------------
    let serpData = [];
    if (task && task.result) {
        // CRITICAL FIX: Use .find() to locate the 'organic' results object
        const organicResult = task.result.find(
            resultItem => resultItem.item_type === 'organic' && Array.isArray(resultItem.items)
        );

        if (organicResult) {
            serpData = organicResult.items;
        }
    }
    
    // ------------------------------------------------------------------
    // C. ANALYZE DATA with OpenAI
    // ------------------------------------------------------------------
    
    // Create a concise text summary of the raw data to send to the AI
    // We slice the data to get the top 5 results and stringify it for the prompt
    const dataSummary = JSON.stringify(serpData.slice(0, 5), null, 2); 
    
    // --- IMPROVEMENT: Modify prompt to handle empty data gracefully ---
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

    // ------------------------------------------------------------------
    // D. RETURN FINAL RESULT
    // ------------------------------------------------------------------
    res.json({
      success: true,
      domain: domain,
      keyword: keyword,
      analysis: analysis,
      raw_data_snippet: serpData.slice(0, 5) // Now contains the actual organic SERP data
    });

  } catch (error) {
    console.error("API Processing Error:", error.message);
    // Check for specific Axios error response from DataForSEO
    const details = error.response ? error.response.data : error.message;

    res.status(500).json({ 
      success: false, 
      error: 'Failed to process SEO analysis.',
      details: details
    });
  }
});

// 5. Start Server
app.listen(PORT, () => {
  console.log(`Server running on http://localhost:${PORT}`);
});