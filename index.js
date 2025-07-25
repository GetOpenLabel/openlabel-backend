const express = require('express');
const axios = require('axios');
require('dotenv').config();

const app = express();
app.use(express.json());

const PORT = process.env.PORT || 3000;

// Lyrics generator (NOW takes a single prompt!)
app.post('/generate-lyrics', async (req, res) => {
  const { prompt } = req.body;

  if (!prompt) {
    return res.status(400).json({ error: "No prompt provided." });
  }

  try {
    // You can update the system prompt for more style if you want.
    const openaiPrompt = `Write original song lyrics based on this prompt: ${prompt}`;

    const response = await axios.post(
      'https://api.openai.com/v1/chat/completions',
      {
        model: 'gpt-3.5-turbo',
        messages: [
          { role: 'system', content: 'You are a songwriting assistant.' },
          { role: 'user', content: openaiPrompt }
        ],
        temperature: 0.8,
        max_tokens: 200,
      },
      {
        headers: {
          'Authorization': `Bearer ${process.env.OPENAI_API_KEY}`,
          'Content-Type': 'application/json'
        },
      }
    );

    const lyrics = response.data.choices[0].message.content;
    res.json({ lyrics });

  } catch (err) {
    console.error('OpenAI API error:', err.response?.data || err.message);
    res.status(500).json({ error: 'Failed to generate lyrics' });
  }
});

// Cover art generator (no changes!)
app.post('/generate-cover-art', async (req, res) => {
  const { prompt } = req.body;

  try {
    const response = await axios.post(
      'https://api.openai.com/v1/images/generations',
      {
        prompt,
        n: 1,
        size: "1024x1024"
      },
      {
        headers: {
          'Authorization': `Bearer ${process.env.OPENAI_API_KEY}`,
          'Content-Type': 'application/json'
        }
      }
    );

    const imageUrl = response.data.data[0].url;
    res.json({ imageUrl });

  } catch (err) {
    console.error('Image generation error:', err.response?.data || err.message);
    res.status(500).json({ error: 'Failed to generate cover art' });
  }
});

app.get('/', (req, res) => {
  res.send('OpenLabel Backend is running!');
});

app.listen(PORT, () => {
  console.log(`Server running on http://localhost:${PORT}`);
});
