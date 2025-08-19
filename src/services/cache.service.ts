// Cache Service using Memory Only (Redis Disabled)
import { logger } from '../utils/logger';

interface CacheServiceInterface {
  get<T>(key: string): Promise<T | null>;
  set(key: string, value: any, ttl?: number): Promise<void>;
  del(key: string): Promise<void>;
  delPattern(pattern: string): Promise<void>;
  exists(key: string): Promise<boolean>;
  ttl(key: string): Promise<number>;
  flush(): Promise<void>;
  disconnect(): Promise<void>;
  isConnected(): boolean;
}

class CacheService implements CacheServiceInterface {
  private fallbackCache = new Map<string, { value: any; expiry: number; setTime: number }>();

  constructor() {
    logger.info('Cache service initialized with memory-only storage (Redis disabled)');
    
    // Clean up expired entries every 5 minutes
    setInterval(() => {
      this.cleanupFallbackCache();
    }, 5 * 60 * 1000);
  }

  private cleanupFallbackCache(): void {
    const now = Date.now();
    let cleaned = 0;
    
    for (const [key, item] of this.fallbackCache.entries()) {
      if (item.expiry < now) {
        this.fallbackCache.delete(key);
        cleaned++;
      }
    }
    
    if (cleaned > 0) {
      logger.debug('Cleaned up expired cache entries', { 
        cleaned, 
        remaining: this.fallbackCache.size 
      });
    }
  }

  async get<T>(key: string): Promise<T | null> {
    try {
      this.cleanupFallbackCache();
      const item = this.fallbackCache.get(key);
      
      if (item && item.expiry > Date.now()) {
        logger.debug('Cache hit (memory)', { key });
        return item.value;
      }
      
      if (item && item.expiry <= Date.now()) {
        // Remove expired item
        this.fallbackCache.delete(key);
      }
      
      logger.debug('Cache miss', { key });
      return null;
      
    } catch (error) {
      logger.error('Error getting cache value', { 
        key, 
        error: error instanceof Error ? error.message : 'Unknown error' 
      });
      return null;
    }
  }

  async set(key: string, value: any, ttl: number = 3600): Promise<void> {
    try {
      const expiry = Date.now() + (ttl * 1000);
      
      this.fallbackCache.set(key, { 
        value: value, 
        expiry: expiry,
        setTime: Date.now()
      });
      
      logger.debug('Cache set (memory)', { 
        key, 
        ttl, 
        totalKeys: this.fallbackCache.size
      });
      
    } catch (error) {
      logger.error('Error setting cache value', { 
        key, 
        error: error instanceof Error ? error.message : 'Unknown error' 
      });
    }
  }

  async del(key: string): Promise<void> {
    try {
      const deleted = this.fallbackCache.delete(key);
      logger.debug('Cache delete', { key, deleted });
    } catch (error) {
      logger.error('Error deleting cache value', { 
        key, 
        error: error instanceof Error ? error.message : 'Unknown error' 
      });
    }
  }

  async delPattern(pattern: string): Promise<void> {
    try {
      const regexPattern = pattern
        .replace(/\*/g, '.*')
        .replace(/\?/g, '.');
      const regex = new RegExp(`^${regexPattern}$`);
      
      let deleted = 0;
      for (const key of this.fallbackCache.keys()) {
        if (regex.test(key)) {
          this.fallbackCache.delete(key);
          deleted++;
        }
      }
      
      logger.debug('Cache pattern delete', { pattern, deleted });
    } catch (error) {
      logger.error('Error deleting cache pattern', { 
        pattern, 
        error: error instanceof Error ? error.message : 'Unknown error' 
      });
    }
  }

  async exists(key: string): Promise<boolean> {
    try {
      this.cleanupFallbackCache();
      const item = this.fallbackCache.get(key);
      const exists = item !== undefined && item.expiry > Date.now();
      
      if (item && item.expiry <= Date.now()) {
        this.fallbackCache.delete(key);
      }
      
      return exists;
    } catch (error) {
      logger.error('Error checking cache existence', { 
        key, 
        error: error instanceof Error ? error.message : 'Unknown error' 
      });
      return false;
    }
  }

  async ttl(key: string): Promise<number> {
    try {
      const item = this.fallbackCache.get(key);
      if (!item) {
        return -2; // Key doesn't exist
      }
      
      const ttl = Math.ceil((item.expiry - Date.now()) / 1000);
      if (ttl <= 0) {
        this.fallbackCache.delete(key);
        return -2; // Key expired
      }
      
      return ttl;
    } catch (error) {
      logger.error('Error getting cache TTL', { 
        key, 
        error: error instanceof Error ? error.message : 'Unknown error' 
      });
      return -1; // Error
    }
  }

  async flush(): Promise<void> {
    try {
      const size = this.fallbackCache.size;
      this.fallbackCache.clear();
      logger.info('Cache flushed', { clearedEntries: size });
    } catch (error) {
      logger.error('Error flushing cache', { 
        error: error instanceof Error ? error.message : 'Unknown error' 
      });
    }
  }

  async disconnect(): Promise<void> {
    logger.info('Cache service disconnected (memory cache cleared)');
    this.fallbackCache.clear();
  }

  isConnected(): boolean {
    return true; // Memory cache is always "connected"
  }

  getStats(): { keys: number; size: string } {
    const keys = this.fallbackCache.size;
    const sizeBytes = JSON.stringify([...this.fallbackCache.entries()]).length;
    const sizeMB = (sizeBytes / 1024 / 1024).toFixed(2);
    
    return {
      keys,
      size: `${sizeMB} MB`
    };
  }

  getAllKeys(): string[] {
    return Array.from(this.fallbackCache.keys());
  }
}

// Create and export singleton instance
const cacheServiceInstance = new CacheService();

export { cacheServiceInstance as cacheService };
export default cacheServiceInstance;
