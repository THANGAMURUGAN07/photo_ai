/**
 * MEGA Storage Adapter
 * Implements cloud storage using MEGA.nz
 */

const { Storage } = require('megajs');
const CloudStorageAdapter = require('./CloudStorageAdapter');
const path = require('path');
const { Readable } = require('stream');

class MegaStorageAdapter extends CloudStorageAdapter {
  constructor(config) {
    super(config);
    this.email = config.email;
    this.password = config.password;
    this.storage = null;
    this.rootFolder = null;
    this.uploadQueue = [];
    this.isUploading = false;
    this.maxConcurrentUploads = 3; // Limit concurrent uploads
  }

  async initialize() {
    try {
      this.storage = await new Storage({
        email: this.email,
        password: this.password
      }).ready;

      // Get or create root folder for the app
      this.rootFolder = this.storage.root;
      
      console.log(`✅ MEGA Storage initialized for ${this.email}`);
      return true;
    } catch (error) {
      console.error('❌ MEGA initialization failed:', error);
      throw error;
    }
  }

  async _getFolder(folderPath) {
    const parts = folderPath.split('/').filter(p => p);
    let current = this.rootFolder;

    for (const part of parts) {
      let found = current.children.find(child => child.name === part && child.directory);
      
      if (!found) {
        // Create folder if it doesn't exist
        found = await current.mkdir(part);
      }
      
      current = found;
    }

    return current;
  }

  async upload(file, filePath, metadata = {}, retries = 3) {
    for (let attempt = 1; attempt <= retries; attempt++) {
      try {
        // Normalize path to use forward slashes for MEGA
        const normalizedPath = filePath.replace(/\\/g, '/');
        const dir = path.dirname(normalizedPath).replace(/\\/g, '/');
        const filename = path.basename(normalizedPath);
        
        // Add delay between uploads to avoid rate limiting
        if (attempt > 1) {
          const delay = attempt * 2000; // 2s, 4s, 6s
          console.log(`⏳ Retry ${attempt}/${retries} for ${filename} after ${delay}ms...`);
          await new Promise(resolve => setTimeout(resolve, delay));
        }
        
        const folder = await this._getFolder(dir);
        
        // Convert buffer to stream if needed
        let fileStream;
        if (Buffer.isBuffer(file)) {
          fileStream = Readable.from(file);
        } else {
          fileStream = file;
        }

        const uploadedFile = await folder.upload({
          name: filename,
          size: file.length || metadata.size
        }, fileStream).complete;

        // Don't generate link immediately - it's slow and causes timeouts
        console.log(`✅ Uploaded to MEGA: ${filePath}`);
        return {
          success: true,
          path: normalizedPath,
          url: `mega://${filename}`, // Placeholder, generate link only when needed
          provider: 'mega',
          nodeId: uploadedFile.nodeId
        };
      } catch (error) {
        if (attempt === retries) {
          console.error(`❌ MEGA upload failed after ${retries} attempts for ${filePath}:`, error.message);
          throw error;
        }
        console.warn(`⚠️  Upload attempt ${attempt} failed, retrying...`);
      }
    }
  }

  async download(filePath) {
    try {
      // Normalize path to use forward slashes for MEGA
      const normalizedPath = filePath.replace(/\\/g, '/');
      const dir = path.dirname(normalizedPath).replace(/\\/g, '/');
      const filename = path.basename(normalizedPath);
      
      const folder = await this._getFolder(dir);
      const file = folder.children.find(child => child.name === filename && !child.directory);
      
      if (!file) {
        throw new Error(`File not found: ${filePath}`);
      }

      const buffer = await file.downloadBuffer();
      return buffer;
    } catch (error) {
      console.error(`❌ MEGA download failed for ${filePath}:`, error);
      throw error;
    }
  }

  async delete(filePath) {
    try {
      // Normalize path to use forward slashes for MEGA
      const normalizedPath = filePath.replace(/\\/g, '/');
      const dir = path.dirname(normalizedPath).replace(/\\/g, '/');
      const filename = path.basename(normalizedPath);
      
      const folder = await this._getFolder(dir);
      const file = folder.children.find(child => child.name === filename);
      
      if (file) {
        await file.delete();
        console.log(`✅ Deleted from MEGA: ${filePath}`);
        return true;
      }
      
      return false;
    } catch (error) {
      console.error(`❌ MEGA delete failed for ${filePath}:`, error);
      return false;
    }
  }

  async list(folderPath) {
    try {
      // Normalize path to use forward slashes for MEGA
      const normalizedPath = folderPath.replace(/\\/g, '/');
      const folder = await this._getFolder(normalizedPath);
      
      return folder.children
        .filter(child => !child.directory)
        .map(file => ({
          name: file.name,
          path: path.join(folderPath, file.name),
          size: file.size,
          lastModified: new Date(file.timestamp * 1000),
          nodeId: file.nodeId
        }));
    } catch (error) {
      console.error(`❌ MEGA list failed for ${folderPath}:`, error);
      return [];
    }
  }

  async getUrl(filePath, expiresIn = 3600) {
    try {
      // Normalize path to use forward slashes for MEGA
      const normalizedPath = filePath.replace(/\\/g, '/');
      const dir = path.dirname(normalizedPath).replace(/\\/g, '/');
      const filename = path.basename(normalizedPath);
      
      const folder = await this._getFolder(dir);
      const file = folder.children.find(child => child.name === filename && !child.directory);
      
      if (!file) {
        throw new Error(`File not found: ${filePath}`);
      }

      // Add timeout wrapper for slow MEGA link generation
      const linkPromise = file.link();
      const timeoutPromise = new Promise((_, reject) => 
        setTimeout(() => reject(new Error('MEGA link generation timeout')), 30000)
      );
      
      const url = await Promise.race([linkPromise, timeoutPromise]);
      return url;
    } catch (error) {
      console.error(`❌ MEGA getUrl failed for ${filePath}:`, error.message);
      // Return a placeholder or throw - app-cloud.js should handle this
      throw error;
    }
  }

  async exists(filePath) {
    try {
      // Normalize path to use forward slashes for MEGA
      const normalizedPath = filePath.replace(/\\/g, '/');
      const dir = path.dirname(normalizedPath).replace(/\\/g, '/');
      const filename = path.basename(normalizedPath);
      
      const folder = await this._getFolder(dir);
      const file = folder.children.find(child => child.name === filename);
      
      return !!file;
    } catch (error) {
      return false;
    }
  }

  async copy(sourcePath, destPath) {
    try {
      // Download and re-upload (MEGA doesn't have native copy)
      const data = await this.download(sourcePath);
      await this.upload(data, destPath);
      
      console.log(`✅ Copied in MEGA: ${sourcePath} -> ${destPath}`);
      return true;
    } catch (error) {
      console.error(`❌ MEGA copy failed:`, error);
      return false;
    }
  }

  async move(sourcePath, destPath) {
    try {
      await this.copy(sourcePath, destPath);
      await this.delete(sourcePath);
      return true;
    } catch (error) {
      console.error(`❌ MEGA move failed:`, error);
      return false;
    }
  }

  async getMetadata(filePath) {
    try {
      const dir = path.dirname(filePath);
      const filename = path.basename(filePath);
      
      const folder = await this._getFolder(dir);
      const file = folder.children.find(child => child.name === filename && !child.directory);
      
      if (!file) {
        throw new Error(`File not found: ${filePath}`);
      }

      return {
        size: file.size,
        lastModified: new Date(file.timestamp * 1000),
        nodeId: file.nodeId,
        name: file.name
      };
    } catch (error) {
      console.error(`❌ MEGA getMetadata failed for ${filePath}:`, error);
      throw error;
    }
  }

  async deleteDirectory(folderPath) {
    try {
      const folder = await this._getFolder(folderPath);
      await folder.delete(true); // true = permanent delete
      
      console.log(`✅ Deleted directory from MEGA: ${folderPath}`);
      return true;
    } catch (error) {
      console.error(`❌ MEGA deleteDirectory failed for ${folderPath}:`, error);
      return false;
    }
  }
}

module.exports = MegaStorageAdapter;
