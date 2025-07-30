const express = require('express');
const axios = require('axios');
const multer = require('multer');
const fs = require('fs');
const FormData = require('form-data');
require('dotenv').config();
const { S3Client, PutObjectCommand } = require('@aws-sdk/client-s3');

const app = express();
app.use(express.json());

const PORT = process.env.PORT || 3000;

// --- Multer Setup for File Uploads ---
const storage = multer.memoryStorage();
const upload = multer({ storage: storage, limits: { fileSize: 50 * 1024 * 1024 } }); // 50MB max

// --- R2 Setup ---
const r2 = new S3Client({
  region: 'auto',
  endpoint: process.env.R2_ENDPOINT,
  credentials: {
    accessKeyId: process.env.R2_ACCESS_KEY_ID,
    secretAccessKey: process.env.R2_SECRET_ACCESS_KEY,
  },
});

// --- API Key Check ---
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
          { role: 'user', content: prompt }
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

// --- AI Song Feedback (File Upload + R2 Storage + Analysis) ---
app.post('/analyze-song', upload.single('file'), async (req, res) => {
  try {
    if (!req.file) {
      return res.status(400).json({ error: 'No file uploaded.' });
    }

    // --- 1. Save file to R2 ---
    const key = `${Date.now()}-${req.file.originalname}`;
    await r2.send(new PutObjectCommand({
      Bucket: process.env.R2_BUCKET_NAME,
      Key: key,
      Body: req.file.buffer,
      ContentType: req.file.mimetype,
    }));
    const fileUrl = `${process.env.R2_ENDPOINT}/${process.env.R2_BUCKET_NAME}/${encodeURIComponent(key)}`;

    // --- 2. Try transcribing with Whisper ---
    let transcript = '';
    try {
      const tempFilePath = `./uploads/${Date.now()}-${req.file.originalname}`;
      fs.writeFileSync(tempFilePath, req.file.buffer);

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
      fs.unlinkSync(tempFilePath); // cleanup
    } catch (e) {
      console.error('Whisper error:', e.response?.data || e.message);
    }

    // --- 3. Prepare GPT feedback ---
    let feedbackPrompt;
    if (transcript && transcript.length > 5) {
      feedbackPrompt = `You are an AI A&R specialist for a record label. Analyze this song's lyrics:\n\n${transcript}\n\nGive structured feedback including: genre, strengths, weaknesses, and suggestions. Be encouraging.`;
    } else {
      feedbackPrompt = `You are an AI A&R specialist for a record label. The system could not extract lyrics from this file: "${req.file.originalname}". Based on it being a ${req.file.mimetype} file, give general constructive feedback about possible strengths, weaknesses, and suggestions for the artist. Be supportive and helpful.`;
    }

    let feedback = {};
    try {
      const gptRes = await axios.post(
        'https://api.openai.com/v1/chat/completions',
        {
          model: 'gpt-3.5-turbo',
          messages: [
            { role: 'system', content: "You're an expert AI A&R music reviewer." },
            { role: 'user', content: feedbackPrompt }
          ],
          max_tokens: 400,
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
      feedback = 'Could not analyze audio in detail, but your file was received successfully!';
    }

    // --- 4. Send structured response ---
    res.json({
      fileUrl,
      transcript: transcript || null,
      feedback,
    });

  } catch (error) {
    console.error('Song analysis error:', error.message);
    res.status(500).json({ error: 'Failed to analyze song.' });
  }
});

app.listen(PORT, () => {
  console.log(`✅ OpenLabel AI Backend running on port ${PORT}`);
});
