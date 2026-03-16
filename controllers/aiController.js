import { CONFIG } from '../config.js';

async function callVertexAI(prompt) {
    const url = `https://us-central1-aiplatform.googleapis.com/v1/projects/${CONFIG.PROJECT_ID}/locations/us-central1/publishers/google/models/${CONFIG.MODEL_NAME}:generateContent?key=${CONFIG.USER_KEY}`;

    const payload = {
        contents: [{ role: "user", parts: [{ text: prompt }] }],
        generationConfig: {
            temperature: 0.7,
            topK: 40,
            topP: 0.95,
            maxOutputTokens: 8192,
        }
    };

    try {
        const response = await fetch(url, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(payload)
        });

        if (!response.ok) {
            const errText = await response.text();
            throw new Error(`Vertex AI Error ${response.status}: ${errText}`);
        }

        const data = await response.json();
        return data.candidates?.[0]?.content?.parts?.[0]?.text || null;
    } catch (error) {
        console.error("AI Call Failed:", error);
        return null; // Return null on error
    }
}

export async function analyzeAndSegmentText(text) {
    const prompt = `
    Analyze this text and split it into logical segments for a chatbot system.
    Return a valid JSON array of objects. Each object must have:
    - "clientName": A short, descriptive name for the topic (e.g., "Prices", "Contact Info").
    - "content": The distinct section of text regarding that topic (keep original details).
    - "keywords": A comma-separated string of 5-10 specific Arabic keywords relevant to this section for retrieval (e.g., "سعر, تكلفة, اشتراك").
    - "type": "topic" (default) or "global" (ONLY if it's general personality/rules/greeting that must ALWAYS be active).

    Text to Analyze:
    ${text}
    `;

    try {
        const textResponse = await callVertexAI(prompt);
        if (!textResponse) return [{
            clientName: "General Instructions",
            content: text,
            keywords: await generateKeywords(text),
            type: "topic"
        }];

        // Clean markdown code blocks
        const cleanResponse = textResponse.replace(/^```json\s*/, "").replace(/\s*```$/, "");

        return JSON.parse(cleanResponse);
    } catch (error) {
        console.error("Gemini Segmentation Error:", error);
        return [{
            clientName: "General Instructions",
            content: text,
            keywords: await generateKeywords(text),
            type: "topic"
        }];
    }
}

export async function generateKeywords(text) {
    const prompt = `
    Generate 5-10 specific Arabic keywords for this text to help a chatbot decide when to use it.
    Return ONLY a comma-separated string (e.g., "word1, word2, word3").
    
    Text: ${text.substring(0, 1000)}
    `;

    try {
        const keywords = await callVertexAI(prompt);
        return keywords ? keywords.trim() : null;
    } catch (error) {
        console.error("Gemini Keyword Error:", error);
        return null;
    }
}
