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

interface CachedNewsEntry {
  data: NewsResponse;
  updatedAt: Date | null;
}

type NewsType = 'mlb' | 'braves';

const DEFAULT_NEWS_CACHE_MAX_AGE_HOURS = parseInt(process.env.NEWS_CACHE_MAX_AGE_HOURS || '6', 10);

export function buildNewsCachePath(newsType: NewsType): string {
  return `news/${newsType}_latest.json`;
}

export function isNewsCacheStale(
  updatedAt: Date | null,
  maxAgeMs: number,
  nowMs = Date.now()
): boolean {
  if (!updatedAt || Number.isNaN(updatedAt.getTime())) {
    return true;
  }

  return nowMs - updatedAt.getTime() > maxAgeMs;
}

export class NewsService {
  private storage: Storage;
  private bigquery: BigQuery;
  private bucketName: string;
  private apiKey: string;
  private baseUrl: string;
  private cacheMaxAgeMs: number;
  private tableReady = false;
  private inFlightRefreshes = new Map<NewsType, Promise<NewsResponse | null>>();

  constructor() {
    this.storage = new Storage();
    this.bigquery = new BigQuery({ projectId: BQ_PROJECT });
    this.bucketName = process.env.GCS_BUCKET_NAME || 'hanks_tank_data';
    this.apiKey = process.env.NEWS_API_KEY || '';
    this.baseUrl = process.env.NEWS_API_BASE_URL || process.env.NEWS_API_URL || 'https://newsapi.org/v2';
    this.cacheMaxAgeMs = DEFAULT_NEWS_CACHE_MAX_AGE_HOURS * 60 * 60 * 1000;

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

  private async requestNews(params: URLSearchParams): Promise<NewsResponse> {
    const url = `${this.baseUrl}/everything?${params.toString()}`;
    const newsResponse = await fetch(url, {
      headers: {
        'X-API-Key': this.apiKey,
      },
      signal: AbortSignal.timeout(10000),
    });

    if (!newsResponse.ok) {
      throw new Error(`News API error: ${newsResponse.status} ${newsResponse.statusText}`);
    }

    return newsResponse.json() as Promise<NewsResponse>;
  }

  private async refreshNewsType(newsType: NewsType): Promise<NewsResponse | null> {
    if (this.inFlightRefreshes.has(newsType)) {
      return this.inFlightRefreshes.get(newsType)!;
    }

    const refreshPromise = (async () => {
      if (newsType === 'mlb') {
        return this.fetchMLBNews();
      }

      return this.fetchBravesNews();
    })().finally(() => {
      this.inFlightRefreshes.delete(newsType);
    });

    this.inFlightRefreshes.set(newsType, refreshPromise);
    return refreshPromise;
  }

  /**
   * Fetch MLB general news
   */
  async fetchMLBNews(): Promise<NewsResponse | null> {
    if (!this.apiKey) {
      logger.warn('Cannot fetch MLB news - API key not configured');
      return null;
    }

    try {
      const params = new URLSearchParams({
        q: 'MLB',
        sortBy: 'publishedAt',
        language: 'en',
        pageSize: '20',
      });

      const data = await this.requestNews(params);
      
      // Store in Cloud Storage (latest cache for frontend)
      await this.storeNewsData('mlb', data);
      // Archive all articles to BigQuery historical store
      await this._archiveToBigQuery('mlb', data.articles);

      logger.info('MLB news fetched and stored successfully', { 
        articles: data.articles.length,
        totalResults: data.totalResults 
      });

      return data;
    } catch (error) {
      logger.error('Error fetching MLB news', {
        error: error instanceof Error ? error.message : 'Unknown error'
      });
      return null;
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

    try {
      const params = new URLSearchParams({
        q: 'Atlanta Braves',
        sortBy: 'publishedAt',
        language: 'en',
        pageSize: '15',
      });

      const data = await this.requestNews(params);
      
      // Store in Cloud Storage (latest cache for frontend)
      await this.storeNewsData('braves', data);
      // Archive all articles to BigQuery historical store
      await this._archiveToBigQuery('braves', data.articles);

      logger.info('Braves news fetched and stored successfully', { 
        articles: data.articles.length,
        totalResults: data.totalResults 
      });

      return data;
    } catch (error) {
      logger.error('Error fetching Braves news', {
        error: error instanceof Error ? error.message : 'Unknown error'
      });
      return null;
    }
  }

  /**
   * Store news data in Cloud Storage
   */
  private async storeNewsData(newsType: string, data: NewsResponse): Promise<void> {
    try {
      const bucket = this.storage.bucket(this.bucketName);
      const fileName = buildNewsCachePath(newsType as NewsType);
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
    const cachedEntry = await this.getCachedNewsEntry(newsType as NewsType);
    return cachedEntry?.data ?? null;
  }

  private async getCachedNewsEntry(newsType: NewsType): Promise<CachedNewsEntry | null> {
    try {
      const bucket = this.storage.bucket(this.bucketName);
      const fileName = buildNewsCachePath(newsType);
      const file = bucket.file(fileName);

      const [exists] = await file.exists();
      if (!exists) {
        logger.warn(`No cached news data found for ${newsType}`);
        return null;
      }

      const [content, metadata] = await Promise.all([
        file.download().then(([downloadedContent]) => downloadedContent),
        file.getMetadata().then(([fileMetadata]) => fileMetadata),
      ]);
      const data: NewsResponse = JSON.parse(content.toString());
      const updatedAtValue = metadata.updated || metadata.timeCreated || null;
      const updatedAt = updatedAtValue ? new Date(updatedAtValue) : null;

      logger.info(`Cached news data retrieved for ${newsType}`, { 
        articles: data.articles.length,
        updatedAt: updatedAt?.toISOString() || null,
      });

      return { data, updatedAt };
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
        this.refreshNewsType('mlb'),
        this.refreshNewsType('braves'),
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
  async getNews(newsType: NewsType): Promise<NewsResponse | null> {
    const cachedEntry = await this.getCachedNewsEntry(newsType);

    if (cachedEntry && !isNewsCacheStale(cachedEntry.updatedAt, this.cacheMaxAgeMs)) {
      return cachedEntry.data;
    }

    const freshData = await this.refreshNewsType(newsType);
    return freshData || cachedEntry?.data || null;
  }
}

export const newsService = new NewsService();
