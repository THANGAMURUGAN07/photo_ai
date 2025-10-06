/**
 * Storage Factory
 * Creates and manages cloud storage adapters based on configuration
 */

const S3StorageAdapter = require('./S3StorageAdapter');
const MegaStorageAdapter = require('./MegaStorageAdapter');
const GCSStorageAdapter = require('./GCSStorageAdapter');

class StorageFactory {
  static adapters = {
    's3': S3StorageAdapter,
    'aws': S3StorageAdapter,
    'mega': MegaStorageAdapter,
    'gcs': GCSStorageAdapter,
    'google': GCSStorageAdapter
  };

  /**
   * Create a storage adapter based on provider
   * @param {string} provider - Storage provider name (s3, mega, gcs)
   * @param {Object} config - Provider-specific configuration
   * @returns {CloudStorageAdapter} Initialized storage adapter
   */
  static async create(provider, config) {
    const normalizedProvider = provider.toLowerCase();
    
    if (!this.adapters[normalizedProvider]) {
      throw new Error(`Unsupported storage provider: ${provider}. Supported: ${Object.keys(this.adapters).join(', ')}`);
    }

    const AdapterClass = this.adapters[normalizedProvider];
    const adapter = new AdapterClass({ ...config, provider: normalizedProvider });
    
    await adapter.initialize();
    
    return adapter;
  }

  /**
   * Create storage adapter from environment variables
   * @returns {CloudStorageAdapter} Initialized storage adapter
   */
  static async createFromEnv() {
    const provider = process.env.CLOUD_STORAGE_PROVIDER || 'local';
    
    if (provider === 'local') {
      console.log('⚠️  Using local storage (CLOUD_STORAGE_PROVIDER not set)');
      return null;
    }

    let config = {};

    switch (provider.toLowerCase()) {
      case 's3':
      case 'aws':
        config = {
          bucket: process.env.AWS_S3_BUCKET,
          region: process.env.AWS_REGION || 'us-east-1',
          accessKeyId: process.env.AWS_ACCESS_KEY_ID,
          secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY
        };
        
        if (!config.bucket || !config.accessKeyId || !config.secretAccessKey) {
          throw new Error('Missing AWS S3 configuration. Required: AWS_S3_BUCKET, AWS_ACCESS_KEY_ID, AWS_SECRET_ACCESS_KEY');
        }
        break;

      case 'mega':
        config = {
          email: process.env.MEGA_EMAIL,
          password: process.env.MEGA_PASSWORD
        };
        
        if (!config.email || !config.password) {
          throw new Error('Missing MEGA configuration. Required: MEGA_EMAIL, MEGA_PASSWORD');
        }
        break;

      case 'gcs':
      case 'google':
        config = {
          bucket: process.env.GCS_BUCKET,
          projectId: process.env.GCS_PROJECT_ID,
          keyFilename: process.env.GCS_KEY_FILENAME
        };
        
        if (!config.bucket || !config.projectId) {
          throw new Error('Missing GCS configuration. Required: GCS_BUCKET, GCS_PROJECT_ID');
        }
        break;

      default:
        throw new Error(`Unsupported storage provider: ${provider}`);
    }

    return await this.create(provider, config);
  }

  /**
   * Register a custom storage adapter
   * @param {string} name - Adapter name
   * @param {Class} AdapterClass - Adapter class
   */
  static register(name, AdapterClass) {
    this.adapters[name.toLowerCase()] = AdapterClass;
    console.log(`✅ Registered custom storage adapter: ${name}`);
  }
}

module.exports = StorageFactory;
