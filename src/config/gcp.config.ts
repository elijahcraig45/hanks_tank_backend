import { config } from 'dotenv';

// Load environment variables
config();

export const gcpConfig = {
  // Google Cloud Project Configuration
  projectId: process.env.GCP_PROJECT_ID || 'hankstank',
  
  // BigQuery Configuration
  bigQuery: {
    dataset: process.env.BQ_DATASET || 'mlb_historical_data',
    location: process.env.BQ_LOCATION || 'US',
    jobTimeoutMs: parseInt(process.env.BQ_JOB_TIMEOUT || '30000'),
  },
  
  // Cloud Storage Configuration
  storage: {
    bucketName: process.env.GCS_BUCKET_NAME || 'hanks_tank_data',
    baseFolder: process.env.GCS_BASE_FOLDER || '',
  },
  
  // Data Source Configuration
  dataSource: {
    currentSeason: parseInt(process.env.CURRENT_SEASON || new Date().getFullYear().toString()),
    historicalDataCutoff: parseInt(process.env.HISTORICAL_DATA_CUTOFF || '2'), // Years
    
    // Cache TTL settings (in seconds)
    cacheTTL: {
      historical: parseInt(process.env.CACHE_TTL_HISTORICAL || '86400'), // 24 hours
      current: parseInt(process.env.CACHE_TTL_CURRENT || '900'), // 15 minutes
      live: parseInt(process.env.CACHE_TTL_LIVE || '600'), // 10 minutes
    },
    
    // Season range for data availability
    minSeason: parseInt(process.env.MIN_SEASON || '2015'),
    maxSeason: parseInt(process.env.MAX_SEASON || '2026'),
  },
  
  // Authentication
  auth: {
    keyFilename: process.env.GOOGLE_APPLICATION_CREDENTIALS,
    // If running on GCP (App Engine, Cloud Run), you can use default credentials
    useDefaultCredentials: process.env.USE_DEFAULT_GCP_CREDENTIALS === 'true',
  }
};

export const isDevelopment = process.env.NODE_ENV === 'development';
export const isProduction = process.env.NODE_ENV === 'production';

// Validate required configuration
export function validateGCPConfig(): { isValid: boolean; errors: string[] } {
  const errors: string[] = [];
  
  if (!gcpConfig.projectId) {
    errors.push('GCP_PROJECT_ID is required');
  }
  
  if (!gcpConfig.storage.bucketName) {
    errors.push('GCS_BUCKET_NAME is required');
  }
  
  if (!gcpConfig.auth.keyFilename && !gcpConfig.auth.useDefaultCredentials) {
    errors.push('Either GOOGLE_APPLICATION_CREDENTIALS or USE_DEFAULT_GCP_CREDENTIALS=true is required');
  }
  
  return {
    isValid: errors.length === 0,
    errors
  };
}
