/**
 * AWS S3 Storage Adapter
 * Implements cloud storage using Amazon S3
 */

const { S3Client, PutObjectCommand, GetObjectCommand, DeleteObjectCommand, 
        ListObjectsV2Command, HeadObjectCommand, CopyObjectCommand } = require('@aws-sdk/client-s3');
const { getSignedUrl } = require('@aws-sdk/s3-request-presigner');
const CloudStorageAdapter = require('./CloudStorageAdapter');
const stream = require('stream');

class S3StorageAdapter extends CloudStorageAdapter {
  constructor(config) {
    super(config);
    this.bucket = config.bucket;
    this.region = config.region || 'us-east-1';
    this.client = null;
  }

  async initialize() {
    try {
      this.client = new S3Client({
        region: this.region,
        credentials: {
          accessKeyId: this.config.accessKeyId,
          secretAccessKey: this.config.secretAccessKey
        }
      });
      console.log(`✅ S3 Storage initialized: ${this.bucket} (${this.region})`);
      return true;
    } catch (error) {
      console.error('❌ S3 initialization failed:', error);
      throw error;
    }
  }

  async upload(file, path, metadata = {}) {
    try {
      const params = {
        Bucket: this.bucket,
        Key: path,
        Body: file,
        ContentType: metadata.mimetype || 'application/octet-stream',
        Metadata: metadata.customMetadata || {}
      };

      const command = new PutObjectCommand(params);
      await this.client.send(command);

      const url = await this.getUrl(path);
      
      console.log(`✅ Uploaded to S3: ${path}`);
      return {
        success: true,
        path: path,
        url: url,
        provider: 's3',
        bucket: this.bucket
      };
    } catch (error) {
      console.error(`❌ S3 upload failed for ${path}:`, error);
      throw error;
    }
  }

  async download(path) {
    try {
      const command = new GetObjectCommand({
        Bucket: this.bucket,
        Key: path
      });

      const response = await this.client.send(command);
      
      // Convert stream to buffer
      const chunks = [];
      for await (const chunk of response.Body) {
        chunks.push(chunk);
      }
      
      return Buffer.concat(chunks);
    } catch (error) {
      console.error(`❌ S3 download failed for ${path}:`, error);
      throw error;
    }
  }

  async delete(path) {
    try {
      const command = new DeleteObjectCommand({
        Bucket: this.bucket,
        Key: path
      });

      await this.client.send(command);
      console.log(`✅ Deleted from S3: ${path}`);
      return true;
    } catch (error) {
      console.error(`❌ S3 delete failed for ${path}:`, error);
      return false;
    }
  }

  async list(path) {
    try {
      const command = new ListObjectsV2Command({
        Bucket: this.bucket,
        Prefix: path
      });

      const response = await this.client.send(command);
      
      return (response.Contents || []).map(item => ({
        name: item.Key.split('/').pop(),
        path: item.Key,
        size: item.Size,
        lastModified: item.LastModified,
        url: `https://${this.bucket}.s3.${this.region}.amazonaws.com/${item.Key}`
      }));
    } catch (error) {
      console.error(`❌ S3 list failed for ${path}:`, error);
      return [];
    }
  }

  async getUrl(path, expiresIn = 3600) {
    try {
      const command = new GetObjectCommand({
        Bucket: this.bucket,
        Key: path
      });

      const url = await getSignedUrl(this.client, command, { expiresIn });
      return url;
    } catch (error) {
      console.error(`❌ S3 getUrl failed for ${path}:`, error);
      // Return public URL as fallback
      return `https://${this.bucket}.s3.${this.region}.amazonaws.com/${path}`;
    }
  }

  async exists(path) {
    try {
      const command = new HeadObjectCommand({
        Bucket: this.bucket,
        Key: path
      });

      await this.client.send(command);
      return true;
    } catch (error) {
      if (error.name === 'NotFound') {
        return false;
      }
      throw error;
    }
  }

  async copy(sourcePath, destPath) {
    try {
      const command = new CopyObjectCommand({
        Bucket: this.bucket,
        CopySource: `${this.bucket}/${sourcePath}`,
        Key: destPath
      });

      await this.client.send(command);
      console.log(`✅ Copied in S3: ${sourcePath} -> ${destPath}`);
      return true;
    } catch (error) {
      console.error(`❌ S3 copy failed:`, error);
      return false;
    }
  }

  async move(sourcePath, destPath) {
    try {
      await this.copy(sourcePath, destPath);
      await this.delete(sourcePath);
      return true;
    } catch (error) {
      console.error(`❌ S3 move failed:`, error);
      return false;
    }
  }

  async getMetadata(path) {
    try {
      const command = new HeadObjectCommand({
        Bucket: this.bucket,
        Key: path
      });

      const response = await this.client.send(command);
      
      return {
        size: response.ContentLength,
        contentType: response.ContentType,
        lastModified: response.LastModified,
        etag: response.ETag,
        metadata: response.Metadata
      };
    } catch (error) {
      console.error(`❌ S3 getMetadata failed for ${path}:`, error);
      throw error;
    }
  }

  async deleteDirectory(path) {
    try {
      // List all objects in the directory
      const objects = await this.list(path);
      
      // Delete each object
      for (const obj of objects) {
        await this.delete(obj.path);
      }
      
      console.log(`✅ Deleted directory from S3: ${path}`);
      return true;
    } catch (error) {
      console.error(`❌ S3 deleteDirectory failed for ${path}:`, error);
      return false;
    }
  }
}

module.exports = S3StorageAdapter;
