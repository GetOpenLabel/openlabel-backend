const express = require('express');
const axios = require('axios');
const fs = require('fs');
const FormData = require('form-data');
require('dotenv').config();
const { S3Client, PutObjectCommand } = require('@aws-sdk/client-s3');

const app = express();
app.use(express.json());

const PORT = process.env.PORT || 3000;

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

// --- AI Song Feedback (URL Upload + R2 Storage + Analysis) ---
app.post('/analyze-song', async (req, res) => {
  try {
    const { url } = req.body;
    if (!url) {
      return res.status(400).json({ error: 'No file URL provided.' });
    }

    console.log("🟡 Received file URL from Bubble:", url);

    // 1. Download file from provided URL
    const axiosRes = await axios.get(url, { responseType: 'arraybuffer' });
    const buffer = Buffer.from(axiosRes.data);
    const mimeType = axiosRes.headers['content-type'] || 'audio/mpeg';

    // 2. Upload file to R2
    const key = `${Date.now()}-bubble-upload.${mimeType.split('/')[1]}`;
    await r2.send(new PutObjectCommand({
      Bucket: process.env.R2_BUCKET_NAME,
      Key: key,
      Body: buffer,
      ContentType: mimeType,
    }));
    const fileUrl = `${process.env.R2_ENDPOINT}/${process.env.R2_BUCKET_NAME}/${encodeURIComponent(key)}`;

    // 3. Save temp file for Whisper
    const tempFilePath = `./uploads/${key}`;
    fs.writeFileSync(tempFilePath, buffer);

    // 4. Transcribe with Whisper
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
            Authorization: `Bearer ${process.env.OPENAI_API_KEY}`,
          },
        }
      );
      transcript = whisperRes.data.text;
    } catch (e) {
      console.error("Whisper error:", e.response?.data || e.message);
    }
    fs.unlinkSync(tempFilePath); // cleanup

    // 5. Generate feedback with GPT
    let feedbackPrompt;
    if (transcript && transcript.length > 5) {
      feedbackPrompt = `You are an AI A&R specialist for a record label. Analyze these lyrics:\n\n${transcript}\n\nProvide feedback: genre, strengths, weaknesses, suggestions. Be encouraging.`;
    } else {
      feedbackPrompt = `You are an AI A&R specialist. The system could not extract lyrics, but this is an audio file. Give constructive general feedback: genre, strengths, weaknesses, suggestions.`;
    }

    let feedback = '';
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
            Authorization: `Bearer ${process.env.OPENAI_API_KEY}`,
            'Content-Type': 'application/json',
          }
        }
      );
      feedback = gptRes.data.choices[0].message.content;
    } catch (err) {
      console.error("GPT error:", err.response?.data || err.message);
      feedback = "Could not analyze in detail, but your file was processed successfully!";
    }

    // 6. Send response back
    res.json({ fileUrl, transcript: transcript || null, feedback });

  } catch (err) {
    console.error("Song analysis error:", err.message);
    res.status(500).json({ error: 'Failed to analyze song.' });
  }
});

// --- Start Server ---
app.listen(PORT, () => {
  console.log(`✅ OpenLabel AI Backend running on port ${PORT}`);
});
