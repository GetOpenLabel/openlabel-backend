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

// --- Multer Setup ---
const storage = multer.memoryStorage();
const upload = multer({ storage, limits: { fileSize: 50 * 1024 * 1024 } }); // 50MB

// --- Cloudflare R2 Setup ---
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
  console.error('❌ OPENAI_API_KEY missing in .env!');
  process.exit(1);
}

// --- Health Check ---
app.get('/', (req, res) => {
  res.send('✅ OpenLabel AI Backend is running!');
});

// --- Utility: Upload to R2 ---
async function uploadToR2(buffer, mimeType, filename) {
  const key = `${Date.now()}-${filename}`;
  await r2.send(new PutObjectCommand({
    Bucket: process.env.R2_BUCKET_NAME,
    Key: key,
    Body: buffer,
    ContentType: mimeType,
  }));
  return `${process.env.R2_ENDPOINT}/${process.env.R2_BUCKET_NAME}/${encodeURIComponent(key)}`;
}

// --- Utility: Transcribe with Whisper ---
async function transcribeAudio(buffer, filename) {
  const tempFilePath = `./uploads/${Date.now()}-${filename}`;
  fs.mkdirSync('./uploads', { recursive: true });
  fs.writeFileSync(tempFilePath, buffer);

  try {
    const formData = new FormData();
    formData.append('file', fs.createReadStream(tempFilePath));
    formData.append('model', 'whisper-1');

    const whisperRes = await axios.post(
      'https://api.openai.com/v1/audio/transcriptions',
      formData,
      { headers: { ...formData.getHeaders(), Authorization: `Bearer ${process.env.OPENAI_API_KEY}` } }
    );

    return whisperRes.data.text || '';
  } catch (err) {
    console.error('Whisper Error:', err.response?.data || err.message);
    return '';
  } finally {
    fs.unlinkSync(tempFilePath);
  }
}

// --- Utility: Generate GPT Feedback ---
async function generateFeedback(transcript, filename, mimeType) {
  const feedbackPrompt = transcript?.length > 5
    ? `You are an AI A&R specialist. Analyze these lyrics:\n\n${transcript}\n\nProvide structured feedback: genre, strengths, weaknesses, suggestions. Be encouraging.`
    : `You are an AI A&R specialist. Could not extract lyrics from "${filename}" (${mimeType}). Provide general constructive feedback with genre, strengths, weaknesses, suggestions.`;

  try {
    const gptRes = await axios.post(
      'https://api.openai.com/v1/chat/completions',
      {
        model: 'gpt-3.5-turbo',
        messages: [
          { role: 'system', content: "You're an expert AI A&R reviewer." },
          { role: 'user', content: feedbackPrompt }
        ],
        max_tokens: 400,
        temperature: 0.8,
      },
      { headers: { Authorization: `Bearer ${process.env.OPENAI_API_KEY}`, 'Content-Type': 'application/json' } }
    );
    return gptRes.data.choices[0].message.content;
  } catch (err) {
    console.error('GPT Feedback Error:', err.response?.data || err.message);
    return 'Could not analyze in detail, but your file was received successfully!';
  }
}

// --- AI Songwriter ---
app.post('/generate-lyrics', async (req, res) => {
  const { prompt } = req.body;
  if (!prompt) return res.status(400).json({ error: 'No prompt provided.' });

  try {
    const response = await axios.post(
      'https://api.openai.com/v1/chat/completions',
      {
        model: 'gpt-3.5-turbo',
        messages: [
          { role: 'system', content: 'You are a creative AI songwriter assistant.' },
          { role: 'user', content: prompt }
        ],
        max_tokens: 400,
        temperature: 0.85,
      },
      { headers: { Authorization: `Bearer ${process.env.OPENAI_API_KEY}`, 'Content-Type': 'application/json' } }
    );
    res.json({ lyrics: response.data.choices[0].message.content });
  } catch (err) {
    console.error('Lyrics Error:', err.response?.data || err.message);
    res.status(500).json({ error: 'Failed to generate lyrics.' });
  }
});

// --- AI Cover Art ---
app.post('/generate-cover-art', async (req, res) => {
  const { prompt } = req.body;
  if (!prompt) return res.status(400).json({ error: 'No prompt provided.' });

  try {
    const response = await axios.post(
      'https://api.openai.com/v1/images/generations',
      { prompt: `Album cover art, ${prompt}, no text`, n: 1, size: '1024x1024' },
      { headers: { Authorization: `Bearer ${process.env.OPENAI_API_KEY}`, 'Content-Type': 'application/json' } }
    );
    res.json({ imageUrl: response.data.data[0].url });
  } catch (err) {
    console.error('Cover Art Error:', err.response?.data || err.message);
    res.status(500).json({ error: 'Failed to generate cover art.' });
  }
});

// --- Analyze Song (Upload or URL) ---
app.post('/analyze-song', upload.single('file'), async (req, res) => {
  try {
    let buffer, filename, mimeType, fileUrl;

    if (req.file) {
      buffer = req.file.buffer;
      filename = req.file.originalname;
      mimeType = req.file.mimetype;
      fileUrl = await uploadToR2(buffer, mimeType, filename);
    } else if (req.body.url) {
      const axiosRes = await axios.get(req.body.url, { responseType: 'arraybuffer' });
      buffer = Buffer.from(axiosRes.data);
      filename = req.body.url.split('/').pop();
      mimeType = axiosRes.headers['content-type'] || 'audio/mpeg';
      fileUrl = await uploadToR2(buffer, mimeType, filename);
    } else {
      return res.status(400).json({ error: 'No file or URL provided.' });
    }

    const transcript = await transcribeAudio(buffer, filename);
    const feedback = await generateFeedback(transcript, filename, mimeType);

    res.json({ fileUrl, transcript: transcript || null, feedback });
  } catch (err) {
    console.error('Analyze Song Error:', err.message);
    res.status(500).json({ error: 'Failed to analyze song.' });
  }
});

app.listen(PORT, () => {
  console.log(`🚀 OpenLabel AI Backend running on port ${PORT}`);
});
