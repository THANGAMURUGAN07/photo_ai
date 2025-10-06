/**
 * PhotoFlow Server with Cloud Storage Integration
 * This version supports AWS S3, MEGA, Google Cloud Storage, and local storage
 */

const express = require("express");
const mongoose = require("mongoose");
const cors = require("cors");
const bodyParser = require("body-parser");
const path = require("path");
const fs = require("fs");
const os = require("os");
const multer = require("multer");
const nodemailer = require("nodemailer");
const QRCode = require("qrcode");
const archiver = require("archiver");
const { spawn, spawnSync } = require("child_process");
require("dotenv").config();

// Import cloud storage modules
const { StorageFactory, createCloudMulter } = require('./storage');

const app = express();
app.use(cors());
app.use(express.json());
app.use(bodyParser.urlencoded({ extended: true }));
app.use(express.static(path.join(__dirname)));

// Global cloud storage adapter
let cloudStorage = null;
let useCloudStorage = false;

// Initialize cloud storage
async function initializeCloudStorage() {
  try {
    const provider = process.env.CLOUD_STORAGE_PROVIDER;
    
    if (!provider || provider === 'local') {
      console.log('📁 Using local file storage');
      useCloudStorage = false;
      return;
    }

    console.log(`☁️  Initializing ${provider.toUpperCase()} cloud storage...`);
    cloudStorage = await StorageFactory.createFromEnv();
    useCloudStorage = true;
    console.log(`✅ Cloud storage ready: ${provider.toUpperCase()}`);
  } catch (error) {
    console.error('❌ Cloud storage initialization failed:', error.message);
    console.log('📁 Falling back to local file storage');
    useCloudStorage = false;
  }
}

// Detect Python command
function detectPythonCommand() {
  const venvPython = path.join(__dirname, '.venv', 'Scripts', 'python.exe');
  if (fs.existsSync(venvPython)) {
    console.log(`🐍 Using virtual environment Python: ${venvPython}`);
    return { cmd: venvPython, args: [] };
  }

  const candidates = [
    { cmd: "py", args: ["-3"] },
    { cmd: "py", args: [] },
    { cmd: "python3", args: [] },
    { cmd: "python", args: [] }
  ];
  
  for (const c of candidates) {
    try {
      const res = spawnSync(c.cmd, [...c.args, "--version"], { encoding: "utf-8" });
      if (res.status === 0 || (res.stdout || res.stderr)?.toLowerCase().includes("python")) {
        console.log(`🐍 Using Python command: ${c.cmd} ${c.args.join(" ")}`);
        return c;
      }
    } catch (_) {}
  }
  
  console.warn("⚠️ No working Python interpreter detected. Defaulting to 'python'.");
  return { cmd: "python", args: [] };
}

const PYTHON = detectPythonCommand();
const PROCESS_TIMEOUT_MS = Number(process.env.PROCESS_TIMEOUT_MS || 15 * 60 * 1000);

// MongoDB Connection
mongoose.connect(process.env.MONGODB_URI, {
  useNewUrlParser: true,
  useUnifiedTopology: true
})
.then(() => console.log("✅ MongoDB connected"))
.catch(err => console.error("❌ MongoDB Error:", err));

// Schemas
const userSchema = new mongoose.Schema({
  name: String,
  email: String,
  phone: String,
  createdAt: { type: Date, default: Date.now }
});
const User = mongoose.model("User", userSchema);

const eventSchema = new mongoose.Schema({
  eventName: { type: String, required: true, unique: true },
  photographerEmail: { type: String, required: true },
  qrCode: String,
  createdAt: { type: Date, default: Date.now },
  status: { type: String, enum: ['active', 'processing', 'completed'], default: 'active' },
  guestCount: { type: Number, default: 0 },
  photoCount: { type: Number, default: 0 },
  useCloudStorage: { type: Boolean, default: false },
  cloudProvider: { type: String, default: null }
});
const Event = mongoose.model("Event", eventSchema);

const guestSchema = new mongoose.Schema({
  email: { type: String, required: true },
  eventName: { type: String, required: true },
  selfieCount: { type: Number, default: 0 },
  matchedPhotoCount: { type: Number, default: 0 },
  zipGenerated: { type: Boolean, default: false },
  emailSent: { type: Boolean, default: false },
  processedAt: { type: Date, default: null },
  createdAt: { type: Date, default: Date.now }
}, { timestamps: true });
const Guest = mongoose.model("Guest", guestSchema);

// Nodemailer setup
const transporter = nodemailer.createTransport({
  host: 'smtp.gmail.com',
  port: 465,
  secure: true,
  auth: {
    user: process.env.EMAIL_USER,
    pass: process.env.EMAIL_PASS
  }
});

transporter.verify((error, success) => {
  if (error) {
    console.error('❌ Email transporter verification failed:', error.message);
  } else {
    console.log('✅ Email transporter is ready');
  }
});

// Events directory (for local storage fallback and temp files)
const EVENTS_DIR = path.join(__dirname, 'events');
if (!fs.existsSync(EVENTS_DIR)) {
  fs.mkdirSync(EVENTS_DIR);
}

// Configure multer based on storage type
let eventUpload;

function configureMulter() {
  if (useCloudStorage && cloudStorage) {
    console.log('☁️  Configuring multer with cloud storage');
    eventUpload = createCloudMulter(cloudStorage);
  } else {
    console.log('📁 Configuring multer with local storage');
    
    const eventStorage = multer.diskStorage({
      destination: (req, file, cb) => {
        const { eventName } = req.params;
        const { email } = req.body;
        
        let folderPath;
        if (req.route.path.includes('selfie') && email) {
          folderPath = path.join(EVENTS_DIR, eventName, 'selfies', email);
        } else {
          folderPath = path.join(EVENTS_DIR, eventName, 'photos');
        }

        if (!fs.existsSync(folderPath)) {
          fs.mkdirSync(folderPath, { recursive: true });
        }
        
        cb(null, folderPath);
      },
      filename: (req, file, cb) => {
        function sanitizeFilename(filename) {
          let sanitized = filename.replace(/[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/g, '');
          sanitized = sanitized.replace(/[\\/:*?"<>|]/g, '_');
          sanitized = sanitized.replace(/_+/g, '_').replace(/^_|_$/g, '');
          if (!sanitized || sanitized === '_') {
            sanitized = 'photo';
          }
          return sanitized;
        }

        const cleanName = sanitizeFilename(file.originalname);
        const filename = Date.now() + '_' + cleanName;
        cb(null, filename);
      }
    });

    const MAX_UPLOAD_MB = parseInt(process.env.MAX_UPLOAD_MB ?? '1024', 10);
    const MAX_UPLOAD_BYTES = MAX_UPLOAD_MB > 0 ? MAX_UPLOAD_MB * 1024 * 1024 : undefined;

    eventUpload = multer({ 
      storage: eventStorage,
      limits: MAX_UPLOAD_BYTES ? { fileSize: MAX_UPLOAD_BYTES } : undefined,
      fileFilter: (req, file, cb) => {
        if (file.mimetype.startsWith('image/')) {
          cb(null, true);
        } else {
          cb(new Error('Only image files are allowed!'));
        }
      }
    });
  }
}

// OTP Storage
const otps = {};

// ================= USER AUTH ROUTES =================

app.post("/api/register", async (req, res) => {
  const { name, email, phone } = req.body;
  const existing = await User.findOne({ $or: [{ email }, { phone }] });
  if (existing) return res.status(400).json({ error: "User already exists" });
  await User.create({ name, email, phone });
  res.json({ message: "Registered successfully" });
});

app.post("/api/send-otp", async (req, res) => {
  const { identifier } = req.body;
  const user = await User.findOne({
    $or: [{ email: identifier }, { phone: identifier }]
  });

  if (!user) {
    return res.status(404).json({ message: "User not found." });
  }
  if (!identifier.includes("@")) {
    return res.status(400).json({ message: "Only email OTP is supported." });
  }

  const otp = Math.floor(100000 + Math.random() * 900000).toString();
  otps[identifier] = otp;

  try {
    await transporter.sendMail({
      from: process.env.EMAIL_USER,
      to: identifier,
      subject: "Your OTP Code",
      text: `Your OTP is ${otp}`
    });
    res.json({ message: "OTP sent to email." });
  } catch (error) {
    console.error(error);
    res.status(500).json({ message: "Failed to send OTP." });
  }
});

app.post("/api/verify-otp", (req, res) => {
  const { identifier, otp } = req.body;
  if (otps[identifier] === otp) {
    delete otps[identifier];
    return res.json({ success: true });
  }
  res.status(400).json({ message: "Invalid OTP." });
});

// ================= EVENT MANAGEMENT ROUTES =================

app.post("/api/create-event", async (req, res) => {
  const { eventName, photographerEmail } = req.body;

  if (!eventName || !photographerEmail) {
    return res.status(400).json({ error: "Event name and photographer email required" });
  }

  try {
    const existingEvent = await Event.findOne({ eventName });
    if (existingEvent) {
      return res.status(400).json({ error: "Event already exists" });
    }

    // Create event folder structure (always create locally for processing)
    const eventPath = path.join(EVENTS_DIR, eventName);
    const subFolders = ['photos', 'selfies', 'matched', 'exports'];

    fs.mkdirSync(eventPath, { recursive: true });
    subFolders.forEach(folder => {
      fs.mkdirSync(path.join(eventPath, folder), { recursive: true });
    });

    // Generate QR Code
    const qrCodeData = `${process.env.BASE_URL || 'http://localhost:5000'}/guest/${eventName}`;
    const qrCodePath = path.join(eventPath, 'qr-code.png');
    await QRCode.toFile(qrCodePath, qrCodeData);

    // Upload QR code to cloud if enabled
    if (useCloudStorage && cloudStorage) {
      const qrBuffer = fs.readFileSync(qrCodePath);
      await cloudStorage.upload(qrBuffer, `events/${eventName}/qr-code.png`, {
        mimetype: 'image/png'
      });
    }

    // Save event to database
    const event = await Event.create({
      eventName,
      photographerEmail,
      qrCode: qrCodeData,
      useCloudStorage: useCloudStorage,
      cloudProvider: useCloudStorage ? process.env.CLOUD_STORAGE_PROVIDER : null
    });

    res.json({
      message: "Event created successfully",
      eventName,
      qrCode: qrCodeData,
      qrCodeImage: `/events/${eventName}/qr-code.png`,
      cloudStorage: useCloudStorage,
      cloudProvider: event.cloudProvider
    });
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: "Failed to create event" });
  }
});

app.get("/api/events", async (req, res) => {
  try {
    const events = await Event.find().sort({ createdAt: -1 });
    res.json(events);
  } catch (error) {
    res.status(500).json({ error: "Failed to fetch events" });
  }
});

app.delete("/api/events/:eventName", async (req, res) => {
  const { eventName } = req.params;
  try {
    const dbResult = await Promise.all([
      Event.deleteOne({ eventName }),
      Guest.deleteMany({ eventName })
    ]);

    // Delete from cloud storage if enabled
    if (useCloudStorage && cloudStorage) {
      await cloudStorage.deleteDirectory(`events/${eventName}`);
    }

    // Remove local event directory
    const eventPath = path.join(EVENTS_DIR, eventName);
    if (fs.existsSync(eventPath)) {
      await fs.promises.rm(eventPath, { recursive: true, force: true });
    }

    res.json({
      success: true,
      message: `Event '${eventName}' deleted permanently`,
      db: { eventDeleted: dbResult[0]?.deletedCount || 0, guestsDeleted: dbResult[1]?.deletedCount || 0 }
    });
  } catch (error) {
    console.error("Delete event error:", error);
    res.status(500).json({ error: "Failed to delete event", details: error.message });
  }
});

// Upload event photos
app.post("/api/upload-event-photos/:eventName", (req, res) => {
  console.log(`📤 Upload event photos request: eventName=${req.params.eventName}`);
  eventUpload.array("photos", 2000)(req, res, async (err) => {
    if (err) {
      if (err.code === 'LIMIT_FILE_SIZE') {
        console.error('❌ Upload error: file too large');
        return res.status(400).json({ error: `File too large. Max ${process.env.MAX_UPLOAD_MB || 1024}MB per photo.` });
      }
      console.error('❌ Upload error:', err.message || err);
      return res.status(400).json({ error: err.message || 'Upload failed' });
    }

    const { eventName } = req.params;
    const filesCount = (req.files || []).length;
    console.log(`✅ Files received: ${filesCount}`);
    if (!filesCount) return res.status(400).json({ error: 'No photos uploaded' });

    try {
      // If using cloud storage, also save to local for processing
      if (useCloudStorage && cloudStorage) {
        console.log('💾 Syncing cloud files to local for processing...');
        const localPhotosPath = path.join(EVENTS_DIR, eventName, 'photos');
        if (!fs.existsSync(localPhotosPath)) {
          fs.mkdirSync(localPhotosPath, { recursive: true });
        }
        
        for (const file of req.files) {
          const localPath = path.join(localPhotosPath, file.filename);
          
          try {
            // Use buffer from upload if available (faster than re-downloading)
            if (file.buffer) {
              fs.writeFileSync(localPath, file.buffer);
              console.log(`✅ Synced ${file.filename} to local (${file.buffer.length} bytes)`);
            } else {
              console.log(`⚠️  No buffer for ${file.filename}, downloading from cloud...`);
              // Fallback: download from cloud
              const cloudPath = file.cloudPath || file.path;
              const buffer = await cloudStorage.download(cloudPath);
              fs.writeFileSync(localPath, buffer);
              console.log(`✅ Downloaded and synced ${file.filename} to local (${buffer.length} bytes)`);
            }
          } catch (downloadErr) {
            console.error(`❌ Failed to sync ${file.filename} to local:`, downloadErr.message);
            console.error(downloadErr);
          }
        }
      }

      await Event.findOneAndUpdate(
        { eventName },
        { $inc: { photoCount: filesCount } }
      );
      
      res.json({ 
        message: `${filesCount} photos uploaded successfully`, 
        photoCount: filesCount,
        cloudStorage: useCloudStorage
      });
    } catch (error) {
      console.error('❌ DB update after upload failed:', error);
      res.status(500).json({ error: 'Failed to record upload in database' });
    }
  });
});

// Guest selfie upload
app.post("/api/upload-selfie/:eventName", (req, res) => {
  console.log(`🔍 Upload selfie request: eventName=${req.params.eventName}`);
  
  eventUpload.array("selfies", 5)(req, res, async (err) => {
    if (err) {
      console.error(`❌ Multer error:`, err);
      return res.status(400).json({ error: err.message });
    }

    const { eventName } = req.params;
    const { email } = req.body;
    
    if (!email || !req.files || req.files.length === 0) {
      return res.status(400).json({ error: "Email and selfie required" });
    }

    try {
      const event = await Event.findOne({ eventName });
      if (!event) {
        return res.status(404).json({ error: "Event not found" });
      }

      // If using cloud storage, sync to local for processing
      if (useCloudStorage && cloudStorage) {
        console.log('💾 Syncing selfies to local for processing...');
        const localSelfiesPath = path.join(EVENTS_DIR, eventName, 'selfies', email);
        if (!fs.existsSync(localSelfiesPath)) {
          fs.mkdirSync(localSelfiesPath, { recursive: true });
        }
        
        for (const file of req.files) {
          const localPath = path.join(localSelfiesPath, file.filename);
          
          try {
            // Use buffer from upload if available (faster than re-downloading)
            if (file.buffer) {
              fs.writeFileSync(localPath, file.buffer);
              console.log(`✅ Synced ${file.filename} to local`);
            } else {
              // Fallback: download from cloud
              const cloudPath = file.cloudPath || file.path;
              const buffer = await cloudStorage.download(cloudPath);
              fs.writeFileSync(localPath, buffer);
              console.log(`✅ Downloaded and synced ${file.filename} to local`);
            }
          } catch (downloadErr) {
            console.error(`⚠️  Failed to sync ${file.filename} to local:`, downloadErr.message);
          }
        }
      }

      const guest = await Guest.findOneAndUpdate(
        { email, eventName },
        {
          $inc: { selfieCount: req.files.length },
          $setOnInsert: { email, eventName }
        },
        { upsert: true, new: true }
      );

      if (guest.selfieCount === req.files.length) {
        await Event.findOneAndUpdate(
          { eventName },
          { $inc: { guestCount: 1 } }
        );
      }

      console.log(`✅ Successfully uploaded ${req.files.length} selfies for ${email}`);

      res.json({
        message: `${req.files.length} selfie(s) uploaded successfully`,
        email,
        selfieCount: guest.selfieCount,
        cloudStorage: useCloudStorage
      });
    } catch (error) {
      console.error(`❌ Database error:`, error);
      res.status(500).json({ error: "Failed to upload selfie" });
    }
  });
});

// Process event (face matching) - continues on next part
app.post("/api/process-event/:eventName", async (req, res) => {
  const { eventName } = req.params;
  
  try {
    await Event.findOneAndUpdate({ eventName }, { status: 'processing' });

    const pythonScript = path.join(__dirname, 'deepface_match_fixed.py');
    const eventPath = path.join(EVENTS_DIR, eventName);

    // Check for selfies and photos
    const selfiesPath = path.join(eventPath, 'selfies');
    let guestCount = 0;
    if (fs.existsSync(selfiesPath)) {
      const guestFolders = fs.readdirSync(selfiesPath).filter(item =>
        fs.statSync(path.join(selfiesPath, item)).isDirectory()
      );
      guestCount = guestFolders.length;
    }

    if (guestCount === 0) {
      await Event.findOneAndUpdate({ eventName }, { status: 'active' });
      return res.status(400).json({
        error: "No guest selfies found",
        message: "Please ensure guests have uploaded selfies before processing"
      });
    }

    const photosPath = path.join(eventPath, 'photos');
    let photoCount = 0;
    if (fs.existsSync(photosPath)) {
      photoCount = fs.readdirSync(photosPath).filter(file => /\.(jpg|jpeg|png|gif|bmp|webp)$/i.test(file)).length;
    }
    
    if (photoCount === 0) {
      await Event.findOneAndUpdate({ eventName }, { status: 'active' });
      return res.status(400).json({
        error: "No photos found",
        message: "Please upload event photos before processing"
      });
    }

    console.log(`🚀 Starting face matching for ${eventName}...`);
    const pythonProcess = spawn(PYTHON.cmd, [...PYTHON.args, pythonScript, eventPath], {
      cwd: __dirname,
      env: { ...process.env }
    });

    let outputData = '';
    let errorData = '';

    const killTimer = setTimeout(async () => {
      console.error(`⏱️ Python process timeout after ${PROCESS_TIMEOUT_MS}ms`);
      try { pythonProcess.kill('SIGKILL'); } catch (_) {}
    }, PROCESS_TIMEOUT_MS);

    pythonProcess.stdout.on('data', (data) => {
      outputData += data.toString();
      console.log(`Python output: ${data}`);
    });

    pythonProcess.on('close', async (code) => {
      clearTimeout(killTimer);
      console.log(`Python process exited with code: ${code}`);

      if (code === 0) {
        await Event.findOneAndUpdate({ eventName }, { status: 'completed' });
        await Guest.updateMany({ eventName, selfieCount: { $gt: 0 } }, { $set: { processedAt: new Date() } });
        
        // Sync matched photos to cloud if enabled
        if (useCloudStorage && cloudStorage) {
          console.log('☁️  Syncing matched photos to cloud...');
          await syncMatchedPhotosToCloud(eventName);
        }
        
        await generateZipFilesAndSendEmails(eventName);
        
        res.json({ 
          message: "Event processing completed successfully", 
          output: outputData,
          guestCount: guestCount,
          cloudStorage: useCloudStorage
        });
      } else {
        await Event.findOneAndUpdate({ eventName }, { status: 'active' });
        res.status(500).json({
          error: "Face recognition processing failed",
          details: errorData,
          exitCode: code
        });
      }
    });

    pythonProcess.on('error', async (error) => {
      console.error(`Failed to start Python process: ${error}`);
      await Event.findOneAndUpdate({ eventName }, { status: 'active' });
      res.status(500).json({
        error: "Failed to start face recognition process",
        details: error.message
      });
    });

  } catch (error) {
    console.error(`Process event error: ${error}`);
    await Event.findOneAndUpdate({ eventName }, { status: 'active' });
    res.status(500).json({ 
      error: "Failed to process event", 
      details: error.message 
    });
  }
});

// Sync matched photos to cloud storage
async function syncMatchedPhotosToCloud(eventName) {
  if (!useCloudStorage || !cloudStorage) return;
  
  try {
    const matchedPath = path.join(EVENTS_DIR, eventName, 'matched');
    if (!fs.existsSync(matchedPath)) return;

    const guestFolders = fs.readdirSync(matchedPath).filter(item =>
      fs.statSync(path.join(matchedPath, item)).isDirectory()
    );

    for (const guestEmail of guestFolders) {
      const guestPath = path.join(matchedPath, guestEmail);
      const photos = fs.readdirSync(guestPath).filter(file =>
        /\.(jpg|jpeg|png|gif|bmp|webp)$/i.test(file)
      );

      for (const photo of photos) {
        const localPath = path.join(guestPath, photo);
        const cloudPath = `events/${eventName}/matched/${guestEmail}/${photo}`;
        
        try {
          const buffer = fs.readFileSync(localPath);
          await cloudStorage.upload(buffer, cloudPath, {
            mimetype: 'image/jpeg'
          });
          console.log(`☁️  Uploaded matched photo: ${cloudPath}`);
        } catch (uploadErr) {
          console.error(`⚠️  Failed to upload ${photo}:`, uploadErr.message);
        }
      }
    }
    
    console.log(`✅ Matched photos synced to cloud for ${eventName}`);
  } catch (error) {
    console.error('Error syncing matched photos to cloud:', error);
  }
}

// Generate zip files and send emails
async function generateZipFilesAndSendEmails(eventName) {
  try {
    const guests = await Guest.find({ eventName });
    if (!guests || guests.length === 0) {
      console.log('⚠️ No guests found for event:', eventName);
      return;
    }

    const eventPath = path.join(EVENTS_DIR, eventName);
    const exportsPath = path.join(eventPath, 'exports');
    if (!fs.existsSync(exportsPath)) {
      fs.mkdirSync(exportsPath, { recursive: true });
    }

    console.log(`🔄 Processing ${guests.length} guests for event: ${eventName}`);
    
    for (const guest of guests) {
      const guestMatchedPath = path.join(eventPath, 'matched', guest.email);
      const zipPath = path.join(eventPath, 'exports', `${guest.email}.zip`);
      
      if (fs.existsSync(guestMatchedPath)) {
        const matchedPhotos = fs.readdirSync(guestMatchedPath);
        if (matchedPhotos.length === 0) continue;

        try {
          if (fs.existsSync(zipPath)) {
            fs.unlinkSync(zipPath);
          }

          await createZipFile(guestMatchedPath, zipPath);
          
          // Upload zip to cloud if enabled
          if (useCloudStorage && cloudStorage) {
            const zipBuffer = fs.readFileSync(zipPath);
            await cloudStorage.upload(zipBuffer, `events/${eventName}/exports/${guest.email}.zip`, {
              mimetype: 'application/zip'
            });
            console.log(`☁️  Uploaded zip to cloud for ${guest.email}`);
          }

          if (process.env.EMAIL_ENABLED && process.env.EMAIL_USER && process.env.EMAIL_PASS) {
            await sendGuestEmail(guest.email, eventName, zipPath);
          }

          await Guest.findOneAndUpdate(
            { email: guest.email, eventName },
            { zipGenerated: true, emailSent: process.env.EMAIL_ENABLED && !!process.env.EMAIL_USER }
          );
        } catch (error) {
          console.error(`❌ Error processing ${guest.email}:`, error);
        }
      }
    }
  } catch (error) {
    console.error('Error in zip generation and email sending:', error);
  }
}

// Create zip file (same as original)
function createZipFile(sourcePath, outputPath) {
  return new Promise((resolve, reject) => {
    let tempDir = null;
    let archive = null;
    
    try {
      if (!fs.existsSync(sourcePath)) {
        throw new Error(`Source path does not exist: ${sourcePath}`);
      }

      const files = fs.readdirSync(sourcePath);
      if (files.length === 0) {
        throw new Error(`No files found in source path: ${sourcePath}`);
      }

      const outputDir = path.dirname(outputPath);
      if (!fs.existsSync(outputDir)) {
        fs.mkdirSync(outputDir, { recursive: true });
      }

      tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'photoai-zip-'));
      const photosDir = path.join(tempDir, 'matched_photos');
      fs.mkdirSync(photosDir);

      let photoCount = 0;
      for (const file of files) {
        const sourcefile = path.join(sourcePath, file);
        const destFile = path.join(photosDir, file);
        fs.copyFileSync(sourcefile, destFile);
        photoCount++;
      }

      const metadata = {
        totalPhotos: photoCount,
        generatedAt: new Date().toISOString(),
        event: path.basename(path.dirname(path.dirname(sourcePath))),
        guest: path.basename(sourcePath)
      };
      
      fs.writeFileSync(
        path.join(tempDir, 'metadata.json'), 
        JSON.stringify(metadata, null, 2)
      );

      const output = fs.createWriteStream(outputPath);
      archive = archiver('zip', { zlib: { level: 9 } });

      output.on('close', () => {
        if (tempDir) {
          try {
            fs.rmSync(tempDir, { recursive: true });
          } catch (err) {
            console.warn('⚠️ Failed to clean up temp directory:', err);
          }
        }
        resolve();
      });

      archive.on('error', (err) => {
        throw err;
      });

      const readmeContent = `Thank you for using our photo matching service!

Event: ${metadata.event}
Total Photos: ${metadata.totalPhotos}
Generated: ${new Date().toLocaleString()}

This zip file contains:
- matched_photos/: All photos that matched your selfie
- metadata.json: Technical details about the matching process
`;
      archive.append(readmeContent, { name: 'README.txt' });
      archive.pipe(output);
      archive.directory(tempDir, false);
      archive.finalize();
    } catch (error) {
      if (tempDir) {
        try {
          fs.rmSync(tempDir, { recursive: true });
        } catch (cleanupErr) {
          console.warn('⚠️ Failed to clean up temp directory:', cleanupErr);
        }
      }
      if (archive && typeof archive.abort === 'function') {
        try {
          archive.abort();
        } catch (archiveErr) {
          console.warn('⚠️ Failed to abort archive:', archiveErr);
        }
      }
      reject(error);
    }
  });
}

// Send email to guest
async function sendGuestEmail(guestEmail, eventName, zipPath) {
  const baseUrl = process.env.BASE_URL || `http://${getNetworkIP()}:5000`;
  const downloadLink = `${baseUrl}/download/${eventName}/${guestEmail}`;
  const mailOptions = {
    from: process.env.EMAIL_USER,
    to: guestEmail,
    subject: `Your Photos from ${eventName}`,
    html: `
      <h2>Your personalized photo album is ready!</h2>
      <p>Thank you for attending ${eventName}. Your photos have been processed and are ready for download.</p>
      <p><a href="${downloadLink}" style="background-color: #4f46e5; color: white; padding: 10px 20px; text-decoration: none; border-radius: 5px;">Download Your Photos</a></p>
      <p>This link will be available for 30 days.</p>
    `
  };
  await transporter.sendMail(mailOptions);
}

// Download guest photos
app.get("/download/:eventName/:email", async (req, res) => {
  const { eventName, email } = req.params;
  
  try {
    // Try cloud storage first
    if (useCloudStorage && cloudStorage) {
      const cloudPath = `events/${eventName}/exports/${email}.zip`;
      const exists = await cloudStorage.exists(cloudPath);
      
      if (exists) {
        console.log(`☁️  Downloading from cloud: ${cloudPath}`);
        const buffer = await cloudStorage.download(cloudPath);
        
        res.setHeader('Content-Type', 'application/zip');
        res.setHeader('Content-Disposition', `attachment; filename="${eventName}_${email.replace('@', '_')}.zip"`);
        res.setHeader('Content-Length', buffer.length);
        res.send(buffer);
        return;
      }
    }
    
    // Fallback to local storage
    const zipPath = path.join(EVENTS_DIR, eventName, 'exports', `${email}.zip`);
    
    if (fs.existsSync(zipPath)) {
      const stats = fs.statSync(zipPath);
      console.log(`📁 Downloading from local: ${zipPath}`);
      
      res.setHeader('Content-Type', 'application/zip');
      res.setHeader('Content-Disposition', `attachment; filename="${eventName}_${email.replace('@', '_')}.zip"`);
      res.setHeader('Content-Length', stats.size);
      
      const fileStream = fs.createReadStream(zipPath);
      fileStream.pipe(res);
    } else {
      res.status(404).json({ 
        error: "Photos not found",
        message: "The requested photo album could not be found."
      });
    }
  } catch (error) {
    console.error('Download error:', error);
    res.status(500).json({ error: "Failed to download photos" });
  }
});

// Guest upload page
app.get("/guest/:eventName", async (req, res) => {
  const { eventName } = req.params;
  try {
    const event = await Event.findOne({ eventName });
    if (!event) {
      return res.status(404).send("Event not found");
    }
    res.sendFile(path.join(__dirname, "guest-upload.html"));
  } catch (error) {
    res.status(500).send("Server error");
  }
});

// ================= PHOTO GALLERY API ROUTES =================

// Get event statistics
app.get("/api/event-stats/:eventName", async (req, res) => {
  const { eventName } = req.params;

  try {
    let totalPhotos = 0;
    let totalGuests = 0;
    let totalMatches = 0;

    if (useCloudStorage && cloudStorage) {
      // Get stats from cloud
      const photos = await cloudStorage.list(`events/${eventName}/photos/`);
      totalPhotos = photos.length;
      
      // Get guests from database (selfie uploaders)
      const guests = await Guest.find({ eventName, selfieCount: { $gt: 0 } });
      totalGuests = guests.length;
      
      const matched = await cloudStorage.list(`events/${eventName}/matched/`);
      totalMatches = matched.length;
    } else {
      // Get stats from local storage
      const eventPath = path.join(EVENTS_DIR, eventName);
      const photosPath = path.join(eventPath, 'photos');
      const selfiesPath = path.join(eventPath, 'selfies');
      const matchedPath = path.join(eventPath, 'matched');

      if (fs.existsSync(photosPath)) {
        const photoFiles = fs.readdirSync(photosPath).filter(file =>
          /\.(jpg|jpeg|png|gif|bmp|webp)$/i.test(file)
        );
        totalPhotos = photoFiles.length;
      }

      // Get guests from database (selfie uploaders)
      const guests = await Guest.find({ eventName, selfieCount: { $gt: 0 } });
      totalGuests = guests.length;

      if (fs.existsSync(matchedPath)) {
        const guestFolders = fs.readdirSync(matchedPath).filter(item =>
          fs.statSync(path.join(matchedPath, item)).isDirectory()
        );

        for (const guestFolder of guestFolders) {
          const guestPath = path.join(matchedPath, guestFolder);
          const matchedFiles = fs.readdirSync(guestPath).filter(file =>
            /\.(jpg|jpeg|png|gif|bmp|webp)$/i.test(file)
          );
          totalMatches += matchedFiles.length;
        }
      }
    }

    res.json({
      totalPhotos,
      totalGuests,
      totalMatches,
      cloudStorage: useCloudStorage
    });

  } catch (error) {
    console.error(error);
    res.status(500).json({ error: "Failed to get event statistics" });
  }
});

// Get list of guest selfies (count only, no images)
app.get("/api/guest-selfies/:eventName", async (req, res) => {
  const { eventName } = req.params;

  try {
    // Get from database - just counts
    const guests = await Guest.find({ eventName, selfieCount: { $gt: 0 } })
      .select('email selfieCount displayName')
      .lean();

    res.json(guests.map(g => ({
      email: g.email,
      selfieCount: g.selfieCount,
      displayName: g.displayName || g.email
    })));

  } catch (error) {
    console.error(`Error getting guest selfies for ${eventName}:`, error);
    res.status(500).json({ error: "Failed to get guest selfies" });
  }
});

// Get list of guests with matched photos (count only, no images)
app.get("/api/guests/:eventName", async (req, res) => {
  const { eventName } = req.params;

  try {
    let guestData = [];

    if (useCloudStorage && cloudStorage) {
      // Use local matched folder (faster and more reliable)
      const matchedPath = path.join(EVENTS_DIR, eventName, 'matched');

      if (!fs.existsSync(matchedPath)) {
        return res.json([]);
      }

      const guestFolders = fs.readdirSync(matchedPath).filter(item => {
        const itemPath = path.join(matchedPath, item);
        return fs.statSync(itemPath).isDirectory();
      });

      guestData = guestFolders.map(guestEmail => {
        const guestPath = path.join(matchedPath, guestEmail);
        const photoFiles = fs.readdirSync(guestPath).filter(file =>
          /\.(jpg|jpeg|png|gif|bmp|webp)$/i.test(file)
        );

        return {
          email: guestEmail,
          matchedCount: photoFiles.length,
          displayName: guestEmail
        };
      });
    } else {
      const matchedPath = path.join(EVENTS_DIR, eventName, 'matched');

      if (!fs.existsSync(matchedPath)) {
        return res.json([]);
      }

      const guestFolders = fs.readdirSync(matchedPath).filter(item => {
        const itemPath = path.join(matchedPath, item);
        return fs.statSync(itemPath).isDirectory();
      });

      guestData = guestFolders.map(guestEmail => {
        const guestPath = path.join(matchedPath, guestEmail);
        const photoFiles = fs.readdirSync(guestPath).filter(file =>
          /\.(jpg|jpeg|png|gif|bmp|webp)$/i.test(file)
        );

        return {
          email: guestEmail,
          matchedCount: photoFiles.length,
          displayName: guestEmail
        };
      });
    }

    res.json(guestData);

  } catch (error) {
    console.error(`Error getting guests for ${eventName}:`, error);
    res.status(500).json({ error: "Failed to get guest list" });
  }
});

// Get all event photos
app.get("/api/event-photos/:eventName", async (req, res) => {
  const { eventName } = req.params;

  try {
    let photos = [];

    if (useCloudStorage && cloudStorage) {
      // Serve from local synced files instead of generating MEGA links (faster)
      const photosPath = path.join(EVENTS_DIR, eventName, 'photos');
      
      if (!fs.existsSync(photosPath)) {
        return res.json([]);
      }

      const photoFiles = fs.readdirSync(photosPath).filter(file =>
        /\.(jpg|jpeg|png|gif|bmp|webp)$/i.test(file)
      );

      photos = photoFiles.map(filename => ({
        name: filename,
        path: `/events/${eventName}/photos/${filename}`
      }));
    } else {
      const photosPath = path.join(EVENTS_DIR, eventName, 'photos');

      if (!fs.existsSync(photosPath)) {
        return res.json([]);
      }

      const photoFiles = fs.readdirSync(photosPath).filter(file =>
        /\.(jpg|jpeg|png|gif|bmp|webp)$/i.test(file)
      );

      photos = photoFiles.map(filename => ({
        name: filename,
        path: `/events/${eventName}/photos/${filename}`
      }));
    }

    res.json(photos);

  } catch (error) {
    console.error(error);
    res.status(500).json({ error: "Failed to get event photos" });
  }
});

// Get guest photos
app.get("/api/guest-photos/:eventName/:guestEmail", async (req, res) => {
  const { eventName, guestEmail } = req.params;

  try {
    let photos = [];

    if (useCloudStorage && cloudStorage) {
      // Serve from local synced files instead of generating MEGA links (faster)
      const guestPath = path.join(EVENTS_DIR, eventName, 'matched', guestEmail);

      if (!fs.existsSync(guestPath)) {
        return res.json([]);
      }

      const photoFiles = fs.readdirSync(guestPath).filter(file =>
        /\.(jpg|jpeg|png|gif|bmp|webp)$/i.test(file)
      );

      photos = photoFiles.map(filename => ({
        name: filename,
        path: `/events/${eventName}/matched/${guestEmail}/${filename}`,
        url: `${req.protocol}://${req.get('host')}/events/${eventName}/matched/${guestEmail}/${filename}`
      }));
    } else {
      const guestPath = path.join(EVENTS_DIR, eventName, 'matched', guestEmail);

      if (!fs.existsSync(guestPath)) {
        return res.json([]);
      }

      const photoFiles = fs.readdirSync(guestPath).filter(file =>
        /\.(jpg|jpeg|png|gif|bmp|webp)$/i.test(file)
      );

      photos = photoFiles.map(filename => ({
        name: filename,
        path: `/events/${eventName}/matched/${guestEmail}/${filename}`,
        url: `${req.protocol}://${req.get('host')}/events/${eventName}/matched/${guestEmail}/${filename}`
      }));
    }

    console.log(`📷 Found ${photos.length} photos for guest ${guestEmail}`);
    res.json(photos);

  } catch (error) {
    console.error(`Error getting photos for guest ${guestEmail}:`, error);
    res.status(500).json({ error: "Failed to get guest photos" });
  }
});

// Serve event files statically (for local storage)
app.use('/events', express.static(EVENTS_DIR));

// Main route
app.get("/", (req, res) => {
  res.sendFile(path.join(__dirname, "login.html"));
});

// Get cloud storage status
app.get("/api/cloud-storage-status", (req, res) => {
  res.json({
    enabled: useCloudStorage,
    provider: useCloudStorage ? process.env.CLOUD_STORAGE_PROVIDER : 'local',
    initialized: !!cloudStorage
  });
});

const PORT = process.env.PORT || 5000;

function getNetworkIP() {
  const nets = os.networkInterfaces();
  for (const name of Object.keys(nets)) {
    for (const net of nets[name]) {
      if (net.family === 'IPv4' && !net.internal) {
        return net.address;
      }
    }
  }
  return 'localhost';
}

const networkIP = getNetworkIP();

// Initialize and start server
async function startServer() {
  await initializeCloudStorage();
  configureMulter();

  const server = app.listen(PORT, '0.0.0.0', () => {
    console.log(`\n${'='.repeat(60)}`);
    console.log(`🚀 PhotoFlow Server Started Successfully!`);
    console.log(`${'='.repeat(60)}`);
    console.log(`📍 Local Access:    http://localhost:${PORT}`);
    console.log(`🌐 Network Access:  http://${networkIP}:${PORT}`);
    console.log(`☁️  Cloud Storage:   ${useCloudStorage ? process.env.CLOUD_STORAGE_PROVIDER.toUpperCase() : 'LOCAL'}`);
    console.log(`${'='.repeat(60)}`);
    console.log(`\n💡 Share the network URL with other devices on the same WiFi\n`);
  });

  try {
    server.requestTimeout = 0;
    server.headersTimeout = 600000;
    server.keepAliveTimeout = 120000;
    server.setTimeout(0);
    console.log('⏱️  Server timeouts adjusted for large uploads');
  } catch (e) {
    console.warn('⚠️ Could not adjust server timeouts:', e.message);
  }
}

startServer().catch(err => {
  console.error('Failed to start server:', err);
  process.exit(1);
});
