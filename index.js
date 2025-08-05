// --- Imports ---
const express = require('express');
const axios = require('axios');
const multer = require('multer');
const fs = require('fs');
const cors = require('cors');
const FormData = require('form-data'); // needed for Whisper uploads
require('dotenv').config();

// --- App Setup ---
const app = express();
app.use(express.json());
app.use(cors()); // allow Bubble frontend to connect

const PORT = process.env.PORT || 3000;

// --- Multer Setup for File Uploads ---
const storage = multer.memoryStorage();
const upload = multer({ storage: storage, limits: { fileSize: 50 * 1024 * 1024 } }); // 50MB max

// --- Check for API Key ---
if (!process.env.OPENAI_API_KEY) {
  console.error('❌ OPENAI_API_KEY is missing in .env!');
  process.exit(1);
}

// --- Health Check ---
app.get('/', (req, res) => {
  res.send('✅ OpenLabel AI Backend is running!');
});

// --- AI Songwriter Endpoint ---
app.post('/generate-lyrics', async (req, res) => {
  const { prompt } = req.body;
  console.log('🟢 Songwriter Prompt Received:', prompt);

  if (!prompt) {
    return res.status(400).json({ success: false, error: 'No prompt provided for lyrics.' });
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
    res.json({ success: true, lyrics });
  } catch (err) {
    console.error('OpenAI Lyrics Error:', err.response?.data || err.message);
    res.status(500).json({ success: false, error: 'Failed to generate lyrics.' });
  }
});

// --- AI Cover Art Generator Endpoint ---
app.post('/generate-cover-art', async (req, res) => {
  const { prompt } = req.body;
  console.log('🟣 Cover Art Prompt Received:', prompt);

  if (!prompt) {
    return res.status(400).json({ success: false, error: 'No prompt provided for cover art.' });
  }

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
    res.json({ success: true, imageUrl });
  } catch (err) {
    console.error('OpenAI Cover Art Error:', err.response?.data || err.message);
    res.status(500).json({ success: false, error: 'Failed to generate cover art.' });
  }
});

// --- AI Song Feedback (File Upload + Real Analysis) ---
app.post('/analyze-song', upload.single('file'), async (req, res) => {
  try {
    if (!req.file) {
      return res.status(400).json({ success: false, error: 'No file uploaded.' });
    }

    // --- 1. Save buffer to temp file ---
    const tempFilePath = `./uploads/${Date.now()}-${req.file.originalname}`;
    fs.writeFileSync(tempFilePath, req.file.buffer);

    let transcript = '';
    try {
      const formData = new FormData();
      formData.append('file', fs.createReadStream(tempFilePath));
      formData.append('model', 'whisper-1');

      const whisperRes = await axios.post(
        'https://api.openai.com/v1/audio/transcriptions',
        formData,
        {
          headers: {
            ...formData.getHeaders(),
            'Authorization': `Bearer ${process.env.OPENAI_API_KEY}`,
          },
        }
      );
      transcript = whisperRes.data.text;
    } catch (e) {
      console.error('Whisper error:', e.response?.data || e.message);
      transcript = '';
    } finally {
      fs.unlinkSync(tempFilePath); // cleanup temp file
    }

    // --- 2. Analyze transcript with GPT ---
    let feedback = '';
    if (transcript && transcript.length > 5) {
      const analysisPrompt = `You are an AI A&R specialist for a record label. 
      Listen to this song's lyrics and analyze its genre, strengths, weaknesses, 
      and give technical feedback for the artist. 
      Song lyrics transcription:\n\n${transcript}\n\n
      Return your analysis in a friendly, constructive, and encouraging style.`;

      try {
        const gptRes = await axios.post(
          'https://api.openai.com/v1/chat/completions',
          {
            model: 'gpt-3.5-turbo',
            messages: [
              { role: 'system', content: "You're an expert AI A&R music reviewer." },
              { role: 'user', content: analysisPrompt }
            ],
            max_tokens: 300,
            temperature: 0.8,
          },
          {
            headers: {
              'Authorization': `Bearer ${process.env.OPENAI_API_KEY}`,
              'Content-Type': 'application/json',
            }
          }
        );
        feedback = gptRes.data.choices[0].message.content;
      } catch (err) {
        console.error('GPT analysis error:', err.response?.data || err.message);
        feedback = 'Could not analyze lyrics, but file was received!';
      }
    } else {
      feedback = `✅ Received your song file "${req.file.originalname}". (But could not transcribe audio.)`;
    }

    res.json({ success: true, feedback });
  } catch (error) {
    console.error('Song analysis error:', error.message);
    res.status(500).json({ success: false, error: 'Failed to analyze song.' });
  }
});

// --- Start Server ---
app.listen(PORT, () => {
  console.log(`✅ OpenLabel AI Backend running on port ${PORT}`);
});
