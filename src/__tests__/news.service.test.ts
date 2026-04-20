const mockFile = {
  exists: jest.fn(),
  download: jest.fn(),
  getMetadata: jest.fn(),
  save: jest.fn(),
};

const mockBucket = {
  file: jest.fn(() => mockFile),
};

const mockStorage = {
  bucket: jest.fn(() => mockBucket),
};

const mockTable = {
  exists: jest.fn(),
  insert: jest.fn(),
};

const mockDataset = {
  table: jest.fn(() => mockTable),
  createTable: jest.fn(),
};

const mockBigQuery = {
  dataset: jest.fn(() => mockDataset),
  query: jest.fn(),
};

jest.mock('@google-cloud/storage', () => ({
  Storage: jest.fn(() => mockStorage),
}));

jest.mock('@google-cloud/bigquery', () => ({
  BigQuery: jest.fn(() => mockBigQuery),
}));

jest.mock('../utils/logger', () => ({
  logger: {
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
  },
}));

import { NewsService, buildNewsCachePath, isNewsCacheStale } from '../services/news.service';

describe('NewsService', () => {
  const originalEnv = process.env;

  beforeEach(() => {
    jest.clearAllMocks();
    process.env = {
      ...originalEnv,
      NEWS_API_KEY: 'test-key',
      GCS_BUCKET_NAME: 'hanks_tank_data',
      NEWS_CACHE_MAX_AGE_HOURS: '6',
    };

    mockTable.exists.mockResolvedValue([true]);
    mockBigQuery.query.mockResolvedValue([[]]);
    mockFile.exists.mockResolvedValue([true]);
    mockFile.save.mockResolvedValue(undefined);
    mockFile.download.mockResolvedValue([
      Buffer.from(JSON.stringify({
        status: 'ok',
        totalResults: 1,
        articles: [
          {
            title: 'Cached article',
            url: 'https://example.com/cached',
            source: { id: null, name: 'Cached Source' },
            author: null,
            description: null,
            urlToImage: null,
            publishedAt: '2026-04-20T10:00:00Z',
            content: null,
          },
        ],
      })),
    ]);
    mockFile.getMetadata.mockResolvedValue([
      { updated: '2026-04-20T15:00:00.000Z' },
    ]);

    global.fetch = jest.fn();
  });

  afterEach(() => {
    process.env = originalEnv;
  });

  it('builds the current news cache path under a stable directory', () => {
    expect(buildNewsCachePath('mlb')).toBe('news/mlb_latest.json');
    expect(buildNewsCachePath('braves')).toBe('news/braves_latest.json');
  });

  it('marks cache entries stale only after the configured max age', () => {
    const now = Date.parse('2026-04-20T18:00:00.000Z');
    const fresh = new Date('2026-04-20T14:30:00.000Z');
    const stale = new Date('2026-04-20T11:30:00.000Z');
    const maxAgeMs = 6 * 60 * 60 * 1000;

    expect(isNewsCacheStale(fresh, maxAgeMs, now)).toBe(false);
    expect(isNewsCacheStale(stale, maxAgeMs, now)).toBe(true);
  });

  it('serves fresh cached news without making an external API request', async () => {
    mockFile.getMetadata.mockResolvedValue([
      { updated: new Date(Date.now() - (60 * 60 * 1000)).toISOString() },
    ]);

    const service = new NewsService();
    const result = await service.getNews('mlb');

    expect(result?.articles[0].title).toBe('Cached article');
    expect(global.fetch).not.toHaveBeenCalled();
    expect(mockBucket.file).toHaveBeenCalledWith('news/mlb_latest.json');
  });

  it('refreshes stale cached news with a single upstream request', async () => {
    mockFile.getMetadata.mockResolvedValue([
      { updated: new Date(Date.now() - (8 * 60 * 60 * 1000)).toISOString() },
    ]);
    (global.fetch as jest.Mock).mockResolvedValue({
      ok: true,
      status: 200,
      statusText: 'OK',
      json: async () => ({
        status: 'ok',
        totalResults: 1,
        articles: [
          {
            title: 'Fresh article',
            url: 'https://example.com/fresh',
            source: { id: null, name: 'Fresh Source' },
            author: null,
            description: null,
            urlToImage: null,
            publishedAt: '2026-04-20T16:00:00Z',
            content: null,
          },
        ],
      }),
    });

    const service = new NewsService();
    const result = await service.getNews('mlb');

    expect(result?.articles[0].title).toBe('Fresh article');
    expect(global.fetch).toHaveBeenCalledTimes(1);
    expect(mockFile.save).toHaveBeenCalledTimes(1);
  });

  it('falls back to stale cached news when the refresh request fails', async () => {
    mockFile.getMetadata.mockResolvedValue([
      { updated: new Date(Date.now() - (8 * 60 * 60 * 1000)).toISOString() },
    ]);
    (global.fetch as jest.Mock).mockResolvedValue({
      ok: false,
      status: 429,
      statusText: 'Too Many Requests',
    });

    const service = new NewsService();
    const result = await service.getNews('braves');

    expect(result?.articles[0].title).toBe('Cached article');
    expect(global.fetch).toHaveBeenCalledTimes(1);
  });
});
