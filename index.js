const express = require('express');
const axios = require('axios');
require('dotenv').config();

const app = express();
app.use(express.json());

const PORT = process.env.PORT || 3000;

app.post('/generate-lyrics', async (req, res) => {
  const { artistName, mood } = req.body;

  try {
    const prompt = `Write song lyrics in the style of ${artistName}, about the mood: ${mood}.`;

    const response = await axios.post(
      'https://api.openai.com/v1/chat/completions',
      {
        model: 'gpt-3.5-turbo',
        messages: [{ role: 'user', content: prompt }],
        temperature: 0.8,
        max_tokens: 200,
      },
      {
        headers: {
          'Authorization': `Bearer ${process.env.OPENAI_API_KEY}`,
        },
      }
    );

    const lyrics = response.data.choices[0].message.content;
    res.json({ lyrics });

  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to generate lyrics' });
  }
});

app.listen(PORT, () => {
  console.log(`Server running on http://localhost:${PORT}`);
});
