/**
 * News Service - Handles news data fetching and caching
 * Scheduled requests to avoid API rate limiting
 */

import { BigQuery } from '@google-cloud/bigquery';
import { Storage } from '@google-cloud/storage';
import * as crypto from 'crypto';
import { logger } from '../utils/logger';

const BQ_PROJECT = process.env.GCP_PROJECT || 'hankstank';
const BQ_DATASET = 'mlb_2026_season';
const BQ_TABLE   = 'news_articles';

const NEWS_TABLE_SCHEMA = [
  { name: 'article_id',    type: 'STRING',    mode: 'REQUIRED' },
  { name: 'url',           type: 'STRING',    mode: 'REQUIRED' },
  { name: 'title',         type: 'STRING',    mode: 'REQUIRED' },
  { name: 'description',   type: 'STRING',    mode: 'NULLABLE' },
  { name: 'content',       type: 'STRING',    mode: 'NULLABLE' },
  { name: 'author',        type: 'STRING',    mode: 'NULLABLE' },
  { name: 'source_id',     type: 'STRING',    mode: 'NULLABLE' },
  { name: 'source_name',   type: 'STRING',    mode: 'NULLABLE' },
  { name: 'url_to_image',  type: 'STRING',    mode: 'NULLABLE' },
  { name: 'published_at',  type: 'TIMESTAMP', mode: 'NULLABLE' },
  { name: 'fetched_at',    type: 'TIMESTAMP', mode: 'REQUIRED' },
  { name: 'news_type',     type: 'STRING',    mode: 'REQUIRED' },
];

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
  private bigquery: BigQuery;
  private bucketName: string;
  private apiKey: string;
  private baseUrl: string;
  private lastFetchTime: { [key: string]: Date } = {};
  private tableReady = false;

  constructor() {
    this.storage = new Storage();
    this.bigquery = new BigQuery({ projectId: BQ_PROJECT });
    this.bucketName = process.env.GCS_BUCKET_NAME || 'hanks_tank_data';
    this.apiKey = process.env.NEWS_API_KEY || '';
    this.baseUrl = process.env.NEWS_API_BASE_URL || 'https://newsapi.org/v2';

    if (!this.apiKey) {
      logger.warn('NEWS_API_KEY not provided - news functionality will be disabled');
    }

    this._ensureNewsTable().catch(err =>
      logger.warn('Could not ensure news_articles BQ table', { error: String(err) })
    );
  }

  /**
   * Create the news_articles BigQuery table if it doesn't already exist.
   */
  private async _ensureNewsTable(): Promise<void> {
    const dataset = this.bigquery.dataset(BQ_DATASET);
    const table   = dataset.table(BQ_TABLE);
    const [exists] = await table.exists();
    if (!exists) {
      await dataset.createTable(BQ_TABLE, {
        schema: NEWS_TABLE_SCHEMA,
        timePartitioning: { type: 'DAY', field: 'fetched_at' },
      });
      logger.info(`Created BigQuery table ${BQ_PROJECT}.${BQ_DATASET}.${BQ_TABLE}`);
    }
    this.tableReady = true;
  }

  /**
   * Archive a batch of articles to BigQuery, skipping URLs already stored.
   */
  private async _archiveToBigQuery(newsType: string, articles: NewsArticle[]): Promise<void> {
    if (!this.tableReady || articles.length === 0) return;

    try {
      const fetchedAt = new Date().toISOString();

      // Collect candidate URLs
      const urls = articles.map(a => a.url);
      const quoted = urls.map(u => `'${u.replace(/'/g, "\\'")}'`).join(',');

      // Find URLs already in BQ (avoid duplicates)
      const [existingRows] = await this.bigquery.query({
        query: `SELECT url FROM \`${BQ_PROJECT}.${BQ_DATASET}.${BQ_TABLE}\` WHERE url IN UNNEST(@urls)`,
        params: { urls },
        types: { urls: ['STRING'] },
      });
      const existingUrls = new Set((existingRows as { url: string }[]).map(r => r.url));

      const newArticles = articles.filter(a => !existingUrls.has(a.url));
      if (newArticles.length === 0) {
        logger.info(`news_archive: all ${articles.length} articles already in BQ (${newsType})`);
        return;
      }

      const rows = newArticles.map(a => ({
        article_id:   crypto.createHash('md5').update(a.url).digest('hex'),
        url:          a.url,
        title:        a.title,
        description:  a.description ?? null,
        content:      a.content ?? null,
        author:       a.author ?? null,
        source_id:    a.source?.id ?? null,
        source_name:  a.source?.name ?? null,
        url_to_image: a.urlToImage ?? null,
        published_at: a.publishedAt ? new Date(a.publishedAt).toISOString() : null,
        fetched_at:   fetchedAt,
        news_type:    newsType,
      }));

      await this.bigquery
        .dataset(BQ_DATASET)
        .table(BQ_TABLE)
        .insert(rows);

      logger.info(`news_archive: inserted ${rows.length} new articles (${newsType})`, {
        skipped: articles.length - rows.length,
      });
    } catch (err) {
      logger.error('news_archive: failed to write to BigQuery', {
        newsType,
        error: err instanceof Error ? err.message : String(err),
      });
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
      
      // Store in Cloud Storage (latest cache for frontend)
      await this.storeNewsData('mlb', data);
      // Archive all articles to BigQuery historical store
      await this._archiveToBigQuery('mlb', data.articles);
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
      
      // Store in Cloud Storage (latest cache for frontend)
      await this.storeNewsData('braves', data);
      // Archive all articles to BigQuery historical store
      await this._archiveToBigQuery('braves', data.articles);
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
