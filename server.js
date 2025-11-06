// server.js (Final Corrected Version)
const express = require('express');
const axios = require('axios');
const app = express();
const port = 3000;

// Middleware to parse JSON bodies
app.use(express.json());

// Load credentials (Assuming these are handled elsewhere or provided via environment variables)
// IMPORTANT: For production, you MUST use process.env.*
const DATA_FOR_SEO_LOGIN = "your_dataforseo_login"; // Replace with process.env.DATA_FOR_SEO_LOGIN
const DATA_FOR_SEO_PASSWORD = "your_dataforseo_password"; // Replace with process.env.DATA_FOR_SEO_PASSWORD
const OPENAI_API_KEY = "your_openai_api_key"; // <-- NEW: Replace with process.env.OPENAI_API_KEY

// --- Core DataForSEO Helper Function ---
async function callDataForSeo(endpoint, tasksArray, options = {}) {
    const { retries = 0 } = options;
    const url = `https://api.dataforseo.com/v3/${endpoint}`;
    
    // Encode credentials for Basic Auth
    const auth = Buffer.from(`${DATA_FOR_SEO_LOGIN}:${DATA_FOR_SEO_PASSWORD}`).toString('base64');
    
    // FIX: The HTTP body must be the tasksArray directly.
    const requestBody = tasksArray;

    const config = {
        method: 'post',
        url: url,
        headers: { 
            'Authorization': `Basic ${auth}`,
            'Content-Type': 'application/json'
        },
        // The body is the array of tasks, as requested by DataForSEO Support
        data: JSON.stringify(requestBody) 
    };

    for (let i = 0; i <= retries; i++) {
        try {
            const response = await axios(config);
            return response.data;
        } catch (error) {
            console.error(`DataForSEO Attempt ${i + 1} failed: ${error.message}`);
            if (i === retries) {
                return { 
                    status_code: 500, 
                    status_message: `Internal Server Error: DataForSEO request failed: ${error.message}` 
                };
            }
            await new Promise(resolve => setTimeout(resolve, 1000 * (i + 1))); 
        }
    }
}

// --- Core OpenAI Helper Function ---
async function callOpenAI(systemPrompt, userPrompt, options = {}) {
    if (!OPENAI_API_KEY || OPENAI_API_KEY.includes('your_openai_api_key')) {
        console.warn("OpenAI API key not configured. Skipping analysis.");
        return "[OpenAI Analysis Skipped: API Key not set]";
    }

    const { model = 'gpt-4o-mini', retries = 3 } = options;
    const url = 'https://api.openai.com/v1/chat/completions';

    const config = {
        method: 'post',
        url: url,
        headers: { 
            'Authorization': `Bearer ${OPENAI_API_KEY}`,
            'Content-Type': 'application/json'
        },
        data: {
            model: model,
            messages: [
                { role: "system", content: systemPrompt },
                { role: "user", content: userPrompt }
            ],
            temperature: 0.2 // Keep analysis factual and low creativity
        }
    };

    for (let i = 0; i <= retries; i++) {
        try {
            const response = await axios(config);
            // Return the content of the first choice
            return response.data.choices[0].message.content;
        } catch (error) {
            console.error(`OpenAI Attempt ${i + 1} failed: ${error.message}`);
            if (i === retries) {
                return `[OpenAI Analysis Failed: ${error.message}]`;
            }
            await new Promise(resolve => setTimeout(resolve, 1000 * (i + 1))); 
        }
    }
}


// --- Express Route ---
app.post('/api/seo-analysis', async (req, res) => {
    try {
        const { keyword, location_code, language_code, domain, device = 'desktop' } = req.body;

        // Basic validation
        if (!keyword || !location_code || !language_code) {
            return res.status(400).json({ error: 'Missing required parameters: keyword, location_code, and language_code.' });
        }
        
        // Ensure location_code is a number
        const locationCode = parseInt(location_code, 10);
        if (isNaN(locationCode)) {
             return res.status(400).json({ error: 'location_code must be a number.' });
        }

        // 1. CONSTRUCT DATA FOR SEO PAYLOAD (Task Object)
        const taskPayload = {
            keyword,
            location_code: locationCode, 
            language_code,
            device
        };

        // Add optional domain field if provided
        if (domain && domain !== 'N/A' && domain.trim() !== '') {
            taskPayload.domain = domain;
        }

        // 2. FETCH DATA from DataForSEO
        const dataForSEOResponse = await callDataForSeo('serp/google/organic/live/advanced', [taskPayload], { retries: 3 });
        
        // Check for DataForSEO errors
        const taskStatus = dataForSEOResponse.tasks?.[0]?.status || dataForSEOResponse.status;
        const taskStatusCode = taskStatus?.code || dataForSEOResponse.status_code;

        if (taskStatusCode !== 20000) {
            // Log the error for internal debugging
            console.error("DataForSEO Task Failed:", taskStatus);

            // Return a structured error response
            return res.status(502).json({
                success: false,
                error: 'DataForSEO API Task Failed.',
                df_status: { 
                    top: dataForSEOResponse.status, 
                    task: taskStatus 
                }
            });
        }
        
        // 3. AI ANALYSIS STEP: Analyze the SERP data
        const serpResults = dataForSEOResponse.tasks[0].result;
        
        // Filter and simplify results to fit context window and focus analysis
        const organicResults = serpResults.items
            .filter(item => item.type === 'organic')
            .slice(0, 10) // Limit to top 10 results
            .map(item => ({
                rank: item.rank_absolute,
                title: item.title,
                url: item.url,
                snippet: item.snippet
            }));
            
        // Construct the prompt for the AI
        const systemPrompt = "You are a world-class SEO analyst. Analyze the provided Google SERP results for the keyword and domain requested by the user. Provide a concise, professional summary that identifies the intent of the top-ranking pages, highlights common keywords or themes used in the titles/snippets, and suggests a strategic angle for a new article to outperform the current results. The response must be a single, well-formatted paragraph.";
        
        const userPrompt = `Analyze the following organic search results for the keyword: "${keyword}" (Target domain: ${domain || 'None specified'}). \n\nSERP Data (JSON):\n${JSON.stringify(organicResults, null, 2)}`;
        
        const aiAnalysis = await callOpenAI(systemPrompt, userPrompt);
        
        // 4. Return combined result
        return res.json({
            success: true,
            keyword: keyword,
            domain: domain || 'N/A',
            serpData: serpResults, // Return the full SERP data
            aiAnalysis: aiAnalysis // Return the AI analysis
        });

    } catch (error) {
        console.error('API execution error:', error.message);
        res.status(500).json({ success: false, error: 'Internal server error.' });
    }
});

// Start the server (assuming your environment provides these globals)
app.listen(port, () => {
    console.log(`Server running at http://localhost:${port}`);
});