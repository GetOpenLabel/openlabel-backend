const express = require('express');
const axios = require('axios');
const multer = require('multer');
const fs = require('fs');
const cors = require('cors');
const {
  S3Client,
  PutObjectCommand,
  GetObjectCommand
} = require('@aws-sdk/client-s3');
const { getSignedUrl } = require('@aws-sdk/s3-request-presigner');
require('dotenv').config();

const app = express();
app.use(express.json());
app.use(cors()); // Allow Bubble calls

const PORT = process.env.PORT || 3000;

// --- Multer Setup for File Uploads ---
const storage = multer.memoryStorage();
const upload = multer({ storage: storage, limits: { fileSize: 50 * 1024 * 1024 } }); // 50MB max

if (!process.env.OPENAI_API_KEY) {
  console.error('❌ OPENAI_API_KEY is missing in .env or Railway variables!');
  process.exit(1);
}

// --- R2 Client Setup ---
const s3 = new S3Client({
  region: 'auto',
  endpoint: process.env.R2_ENDPOINT,
  credentials: {
    accessKeyId: process.env.R2_ACCESS_KEY_ID,
    secretAccessKey: process.env.R2_SECRET_ACCESS_KEY,
  },
});

// --- Health Check ---
app.get('/', (req, res) => {
  res.send('✅ OpenLabel AI Backend is running!');
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

// --- AI Song Feedback (Upload + Analysis) ---
app.post('/analyze-song', upload.single('file'), async (req, res) => {
  try {
    if (!req.file) {
      return res.status(400).json({ error: 'No file uploaded.' });
    }

    // Save file temporarily
    const tempFilePath = `./uploads/${Date.now()}-${req.file.originalname}`;
    fs.writeFileSync(tempFilePath, req.file.buffer);

    let transcript = '';
    try {
      const FormData = require('form-data');
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
      fs.unlinkSync(tempFilePath);
    }

    let feedback = '';
    if (transcript && transcript.length > 5) {
      const prompt = `You are an AI A&R specialist for a record label. Analyze this song's lyrics:\n\n${transcript}\n\nGive genre, strengths, weaknesses, and technical feedback.`;
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

    res.json({ feedback });
  } catch (error) {
    console.error('Song analysis error:', error.message);
    res.status(500).json({ error: 'Failed to analyze song.' });
  }
});

// --- New: Upload to R2 ---
app.post('/upload', upload.single('file'), async (req, res) => {
  try {
    const file = req.file;
    const command = new PutObjectCommand({
      Bucket: process.env.R2_BUCKET_NAME,
      Key: file.originalname,
      Body: file.buffer,
      ContentType: file.mimetype,
    });
    await s3.send(command);
    res.json({ message: 'File uploaded to R2', key: file.originalname });
  } catch (err) {
    console.error('R2 Upload Error:', err);
    res.status(500).json({ error: 'Upload to R2 failed' });
  }
});

// --- New: Get Signed Playback URL from R2 ---
app.get('/file/:key', async (req, res) => {
  try {
    const command = new GetObjectCommand({
      Bucket: process.env.R2_BUCKET_NAME,
      Key: req.params.key,
    });
    const url = await getSignedUrl(s3, command, { expiresIn: 3600 }); // 1 hr
    res.json({ url });
  } catch (err) {
    console.error('R2 Get File Error:', err);
    res.status(500).json({ error: 'Failed to get file from R2' });
  }
});

app.listen(PORT, () => {
  console.log(`✅ OpenLabel AI Backend running on port ${PORT}`);
});
