const express = require('express');
const axios = require('axios');
require('dotenv').config();

const app = express();
app.use(express.json());

const PORT = process.env.PORT || 3000;

if (!process.env.OPENAI_API_KEY) {
  console.error('❌ OPENAI_API_KEY is missing in .env!');
  process.exit(1);
}

// --- Health Check ---
app.get('/', (req, res) => {
  res.send('OpenLabel AI Backend is running!');
});

// --- AI Songwriter Endpoint ---
app.post('/generate-lyrics', async (req, res) => {
  const { prompt } = req.body;
  console.log('🟢 Songwriter Prompt Received:', prompt);

  if (!prompt) {
    return res.status(400).json({ error: 'No prompt provided for lyrics.' });
  }

  try {
    const response = await axios.post(
      'https://api.openai.com/v1/chat/completions',
      {
        model: 'gpt-3.5-turbo',
        messages: [
          {
            role: 'system',
            content: 'You are a creative AI songwriter assistant. Write original song lyrics based on the prompt.'
          },
          {
            role: 'user',
            content: prompt
          }
        ],
        max_tokens: 400,
        temperature: 0.85,
      },
      {
        headers: {
          'Authorization': `Bearer ${process.env.OPENAI_API_KEY}`,
          'Content-Type': 'application/json',
        },
      }
    );
    const lyrics = response.data.choices[0].message.content;
    res.json({ lyrics });
  } catch (err) {
    console.error('OpenAI Lyrics Error:', err.response?.data || err.message);
    res.status(500).json({ error: 'Failed to generate lyrics.' });
  }
});

// --- AI Cover Art Generator Endpoint ---
app.post('/generate-cover-art', async (req, res) => {
  const { prompt } = req.body;
  console.log('🟣 Cover Art Prompt Received:', prompt);

  if (!prompt) {
    return res.status(400).json({ error: 'No prompt provided for cover art.' });
  }

  // Optional: Add "Album cover art" context for better DALL-E results
  const fullPrompt = `Album cover art, ${prompt}, no text`;

  try {
    const response = await axios.post(
      'https://api.openai.com/v1/images/generations',
      {
        prompt: fullPrompt,
        n: 1,
        size: '1024x1024',
        response_format: 'url',
      },
      {
        headers: {
          'Authorization': `Bearer ${process.env.OPENAI_API_KEY}`,
          'Content-Type': 'application/json',
        },
      }
    );
    const imageUrl = response.data.data[0].url;
    res.json({ imageUrl });
  } catch (err) {
    console.error('OpenAI Cover Art Error:', err.response?.data || err.message);
    res.status(500).json({ error: 'Failed to generate cover art.' });
  }
});

app.listen(PORT, () => {
  console.log(`✅ OpenLabel AI Backend running on port ${PORT}`);
});
