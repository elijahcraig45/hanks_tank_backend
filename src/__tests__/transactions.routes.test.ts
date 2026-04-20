import express from 'express';
import transactionsRoutes from '../routes/transactions.routes';
import { transactionsService } from '../services/transactions.service';

jest.mock('../services/transactions.service', () => ({
  transactionsService: {
    getTransactions: jest.fn(),
    getRecentTransactions: jest.fn(),
    getTransactionsByYear: jest.fn(),
    getTeamTransactions: jest.fn(),
    getTransactionTypeBreakdown: jest.fn(),
  },
}));

const app = express();
app.use(express.json());
app.use('/api/transactions', transactionsRoutes);

describe('transactions routes', () => {
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

  test('returns transactions with parsed filters', async () => {
    (transactionsService.getTransactions as jest.Mock).mockResolvedValue([
      { date: '2026-04-20', typeDesc: 'Trade', person: { id: 1, fullName: 'Player', link: '/p/1' } },
    ]);

    const response = await fetch(
      `${baseUrl}/api/transactions?teamId=144&startDate=2026-04-01&endDate=2026-04-20`
    );
    const body: any = await response.json();

    expect(response.status).toBe(200);
    expect(transactionsService.getTransactions).toHaveBeenCalledWith({
      teamId: 144,
      startDate: '2026-04-01',
      endDate: '2026-04-20',
    });
    expect(body.success).toBe(true);
    expect(body.meta.filters.teamId).toBe(144);
  });

  test('rejects invalid year values', async () => {
    const response = await fetch(`${baseUrl}/api/transactions/year/not-a-year`);
    const body: any = await response.json();

    expect(response.status).toBe(400);
    expect(body.error.code).toBe('INVALID_YEAR');
  });

  test('returns team transaction breakdown as an object', async () => {
    (transactionsService.getTransactionTypeBreakdown as jest.Mock).mockResolvedValue(
      new Map([
        ['Trade', 2],
        ['Claim', 1],
      ])
    );

    const response = await fetch(`${baseUrl}/api/transactions/team/144/breakdown`);
    const body: any = await response.json();

    expect(response.status).toBe(200);
    expect(body.success).toBe(true);
    expect(body.data).toEqual({ Trade: 2, Claim: 1 });
  });
});
