/**
 * News Service - Handles news data fetching and caching
 * Scheduled requests to avoid API rate limiting
 */

import { Storage } from '@google-cloud/storage';
import { logger } from '../utils/logger';

interface NewsArticle {
  source: {
    id: string | null;
    name: string;
  };
  author: string | null;
  title: string;
  description: string | null;
  url: string;
  urlToImage: string | null;
  publishedAt: string;
  content: string | null;
}

interface NewsResponse {
  status: string;
  totalResults: number;
  articles: NewsArticle[];
}

export class NewsService {
  private storage: Storage;
  private bucketName: string;
  private apiKey: string;
  private baseUrl: string;
  private lastFetchTime: { [key: string]: Date } = {};

  constructor() {
    this.storage = new Storage();
    this.bucketName = process.env.GCS_BUCKET_NAME || 'hanks_tank_data';
    this.apiKey = process.env.NEWS_API_KEY || '';
    this.baseUrl = process.env.NEWS_API_BASE_URL || 'https://newsapi.org/v2';

    if (!this.apiKey) {
      logger.warn('NEWS_API_KEY not provided - news functionality will be disabled');
    }
  }

  /**
   * Check if we should fetch news (rate limiting protection)
   */
  private shouldFetchNews(newsType: string): boolean {
    const lastFetch = this.lastFetchTime[newsType];
    if (!lastFetch) return true;

    // Only allow fetching every 4 hours minimum
    const fourHoursAgo = new Date(Date.now() - 4 * 60 * 60 * 1000);
    return lastFetch < fourHoursAgo;
  }

  /**
   * Fetch MLB general news
   */
  async fetchMLBNews(): Promise<NewsResponse | null> {
    if (!this.apiKey) {
      logger.warn('Cannot fetch MLB news - API key not configured');
      return null;
    }

    if (!this.shouldFetchNews('mlb')) {
      logger.info('Skipping MLB news fetch - too recent');
      return await this.getCachedNews('mlb');
    }

    try {
      const response = await fetch(`${this.baseUrl}/everything`, {
        method: 'GET',
        headers: {
          'X-API-Key': this.apiKey,
        },
        body: null,
        signal: AbortSignal.timeout(10000), // 10 second timeout
      });

      const params = new URLSearchParams({
        q: 'MLB',
        sortBy: 'publishedAt',
        language: 'en',
        pageSize: '20',
      });

      const url = `${this.baseUrl}/everything?${params}`;
      const newsResponse = await fetch(url, {
        headers: {
          'X-API-Key': this.apiKey,
        },
      });

      if (!newsResponse.ok) {
        throw new Error(`News API error: ${newsResponse.status} ${newsResponse.statusText}`);
      }

      const data = await newsResponse.json() as NewsResponse;
      
      // Store in Cloud Storage
      await this.storeNewsData('mlb', data);
      this.lastFetchTime['mlb'] = new Date();

      logger.info('MLB news fetched and stored successfully', { 
        articles: data.articles.length,
        totalResults: data.totalResults 
      });

      return data;
    } catch (error) {
      logger.error('Error fetching MLB news', {
        error: error instanceof Error ? error.message : 'Unknown error'
      });
      
      // Return cached data if available
      return await this.getCachedNews('mlb');
    }
  }

  /**
   * Fetch Atlanta Braves specific news
   */
  async fetchBravesNews(): Promise<NewsResponse | null> {
    if (!this.apiKey) {
      logger.warn('Cannot fetch Braves news - API key not configured');
      return null;
    }

    if (!this.shouldFetchNews('braves')) {
      logger.info('Skipping Braves news fetch - too recent');
      return await this.getCachedNews('braves');
    }

    try {
      const params = new URLSearchParams({
        q: 'Atlanta Braves',
        sortBy: 'publishedAt',
        language: 'en',
        pageSize: '15',
      });

      const url = `${this.baseUrl}/everything?${params}`;
      const newsResponse = await fetch(url, {
        headers: {
          'X-API-Key': this.apiKey,
        },
      });

      if (!newsResponse.ok) {
        throw new Error(`News API error: ${newsResponse.status} ${newsResponse.statusText}`);
      }

      const data = await newsResponse.json() as NewsResponse;
      
      // Store in Cloud Storage
      await this.storeNewsData('braves', data);
      this.lastFetchTime['braves'] = new Date();

      logger.info('Braves news fetched and stored successfully', { 
        articles: data.articles.length,
        totalResults: data.totalResults 
      });

      return data;
    } catch (error) {
      logger.error('Error fetching Braves news', {
        error: error instanceof Error ? error.message : 'Unknown error'
      });
      
      // Return cached data if available
      return await this.getCachedNews('braves');
    }
  }

  /**
   * Store news data in Cloud Storage
   */
  private async storeNewsData(newsType: string, data: NewsResponse): Promise<void> {
    try {
      const bucket = this.storage.bucket(this.bucketName);
      const fileName = `2024/${newsType}_news.json`;
      const file = bucket.file(fileName);

      await file.save(JSON.stringify(data, null, 2), {
        metadata: {
          contentType: 'application/json',
          cacheControl: 'public, max-age=3600', // 1 hour cache
        },
      });

      logger.info(`News data stored in Cloud Storage`, { 
        bucket: this.bucketName, 
        file: fileName,
        articles: data.articles.length 
      });
    } catch (error) {
      logger.error('Error storing news data in Cloud Storage', {
        newsType,
        error: error instanceof Error ? error.message : 'Unknown error'
      });
      throw error;
    }
  }

  /**
   * Get cached news data from Cloud Storage
   */
  async getCachedNews(newsType: string): Promise<NewsResponse | null> {
    try {
      const bucket = this.storage.bucket(this.bucketName);
      const fileName = `2024/${newsType}_news.json`;
      const file = bucket.file(fileName);

      const [exists] = await file.exists();
      if (!exists) {
        logger.warn(`No cached news data found for ${newsType}`);
        return null;
      }

      const [content] = await file.download();
      const data: NewsResponse = JSON.parse(content.toString());

      logger.info(`Cached news data retrieved for ${newsType}`, { 
        articles: data.articles.length 
      });

      return data;
    } catch (error) {
      logger.error('Error retrieving cached news data', {
        newsType,
        error: error instanceof Error ? error.message : 'Unknown error'
      });
      return null;
    }
  }

  /**
   * Scheduled news fetch - called by cron job
   */
  async scheduledNewsFetch(): Promise<void> {
    logger.info('Starting scheduled news fetch');
    
    try {
      // Fetch both news types
      await Promise.allSettled([
        this.fetchMLBNews(),
        this.fetchBravesNews(),
      ]);
      
      logger.info('Scheduled news fetch completed');
    } catch (error) {
      logger.error('Error in scheduled news fetch', {
        error: error instanceof Error ? error.message : 'Unknown error'
      });
    }
  }

  /**
   * Get fresh or cached news data
   */
  async getNews(newsType: 'mlb' | 'braves'): Promise<NewsResponse | null> {
    // First try to get cached data
    let data = await this.getCachedNews(newsType);
    
    // If no cached data or data is old, try to fetch fresh
    if (!data) {
      if (newsType === 'mlb') {
        data = await this.fetchMLBNews();
      } else {
        data = await this.fetchBravesNews();
      }
    }

    return data;
  }
}

export const newsService = new NewsService();
