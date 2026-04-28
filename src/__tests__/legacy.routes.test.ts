import express from 'express';
import legacyRoutes from '../routes/legacy.routes';
import { mlbApi } from '../services/mlb-api.service';

jest.mock('../services/mlb-api.service', () => ({
  mlbApi: {
    getGameById: jest.fn(),
  },
}));

jest.mock('../services/data-source.service', () => ({
  dataSourceService: {},
}));

jest.mock('../services/news.service', () => ({
  newsService: {},
}));

jest.mock('../utils/logger', () => ({
  logger: {
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
    debug: jest.fn(),
  },
}));

const app = express();
app.use(express.json());
app.use('/api', legacyRoutes);

describe('legacy routes', () => {
  let server: ReturnType<typeof app.listen>;
  let baseUrl: string;

  beforeAll((done) => {
    server = app.listen(0, () => {
      const address = server.address();
      if (!address || typeof address === 'string') {
        throw new Error('Failed to bind test server');
      }

      baseUrl = `http://127.0.0.1:${address.port}`;
      done();
    });
  });

  afterAll((done) => {
    server.close(done);
  });

  beforeEach(() => {
    jest.clearAllMocks();
  });

  test('rejects invalid game ids before calling MLB API', async () => {
    const response = await fetch(`${baseUrl}/api/games/not-a-number`);
    const body: any = await response.json();

    expect(response.status).toBe(400);
    expect(body.error).toBe('Invalid gamePk');
    expect(mlbApi.getGameById).not.toHaveBeenCalled();
  });

  test('returns 404 when upstream game feed is missing', async () => {
    const upstreamError = Object.assign(new Error('Request failed with status code 404'), {
      isAxiosError: true,
      response: { status: 404 },
    });
    (mlbApi.getGameById as jest.Mock).mockRejectedValue(upstreamError);

    const response = await fetch(`${baseUrl}/api/games/824447`);
    const body: any = await response.json();

    expect(response.status).toBe(404);
    expect(body.error).toBe('Game not found');
  });

  test('returns game details when the upstream feed succeeds', async () => {
    (mlbApi.getGameById as jest.Mock).mockResolvedValue({ gamePk: 824447, liveData: {} });

    const response = await fetch(`${baseUrl}/api/games/824447`);
    const body: any = await response.json();

    expect(response.status).toBe(200);
    expect(body.gamePk).toBe(824447);
    expect(mlbApi.getGameById).toHaveBeenCalledWith(824447);
  });
});
