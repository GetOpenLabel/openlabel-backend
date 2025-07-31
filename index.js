const express = require('express');
const axios = require('axios');
const multer = require('multer');
const fs = require('fs');
require('dotenv').config();

const app = express();
app.use(express.json());

const PORT = process.env.PORT || 3000;

// --- Multer Setup for File Uploads ---
const storage = multer.memoryStorage();
const upload = multer({ storage: storage, limits: { fileSize: 50 * 1024 * 1024 } }); // 50MB max

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
          'Authorization': Bearer ${process.env.OPENAI_API_KEY},
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
  const fullPrompt = Album cover art, ${prompt}, no text;

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
          'Authorization': Bearer ${process.env.OPENAI_API_KEY},
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

// --- AI Song Feedback (File Upload + Real Analysis) ---
app.post('/analyze-song', upload.single('file'), async (req, res) => {
  try {
    if (!req.file) {
      return res.status(400).json({ error: 'No file uploaded.' });
    }

    // --- 1. Transcribe the uploaded audio with OpenAI Whisper ---
    // Write buffer to a temp file
    const tempFilePath = ./uploads/${Date.now()}-${req.file.originalname};
    fs.writeFileSync(tempFilePath, req.file.buffer);

    let transcript = '';
    try {
      const formData = new FormData();
      formData.append('file', fs.createReadStream(tempFilePath));
      formData.append('model', 'whisper-1');
      // Use axios POST with proper headers for multipart/form-data
      const whisperRes = await axios.post(
        'https://api.openai.com/v1/audio/transcriptions',
        formData,
        {
          headers: {
            ...formData.getHeaders(),
            'Authorization': Bearer ${process.env.OPENAI_API_KEY},
          },
        }
      );
      transcript = whisperRes.data.text;
    } catch (e) {
      // If Whisper fails, fallback to just file info
      console.error('Whisper error:', e.response?.data || e.message);
      transcript = '';
    } finally {
      fs.unlinkSync(tempFilePath); // Clean up file
    }

    // --- 2. If transcript available, send to GPT for feedback ---
    let feedback = '';
    if (transcript && transcript.length > 5) {
      const prompt = You are an AI A&R specialist for a record label. Listen to this song's lyrics and analyze its genre, strengths, weaknesses, and give technical feedback for the artist. Song lyrics transcription:\n\n${transcript}\n\nReturn your analysis in a friendly, constructive, and encouraging style.;
      try {
        const gptRes = await axios.post(
          'https://api.openai.com/v1/chat/completions',
          {
            model: 'gpt-3.5-turbo',
            messages: [
              { role: 'system', content: "You're an expert AI A&R music reviewer." },
              { role: 'user', content: prompt }
            ],
            max_tokens: 300,
            temperature: 0.8,
          },
          {
            headers: {
              'Authorization': Bearer ${process.env.OPENAI_API_KEY},
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
      feedback = ✅ Received your song file "${req.file.originalname}". (But could not transcribe audio.);
    }

    res.json({ feedback });
  } catch (error) {
    console.error('Song analysis error:', error.message);
    res.status(500).json({ error: 'Failed to analyze song.' });
  }
});

app.listen(PORT, () => {
  console.log(✅ OpenLabel AI Backend running on port ${PORT});
});
