import { transactionsService } from '../services/transactions.service';

describe('transactions service', () => {
  test('parseTransactions maps teams and filters entries without a player', () => {
    const service = transactionsService as any;
    const parsed = service.parseTransactions({
      transactions: [
        {
          id: 7,
          date: '2026-04-20',
          typeCode: 'T',
          typeDesc: 'Trade',
          description: 'Sample trade',
          fromTeam: { id: 144, name: 'Atlanta Braves', teamCode: 'ATL' },
          toTeam: { id: 121, name: 'New York Mets', abbreviation: 'NYM' },
          person: { id: 99, fullName: 'Test Player', link: '/people/99' },
        },
        {
          id: 8,
          date: '2026-04-20',
          typeCode: 'S',
          typeDesc: 'Signing',
          description: 'Missing player should be filtered',
          person: null,
        },
      ],
    });

    expect(parsed).toHaveLength(1);
    expect(parsed[0]).toMatchObject({
      id: 7,
      typeDesc: 'Trade',
      fromTeam: { abbreviation: 'ATL' },
      toTeam: { abbreviation: 'NYM' },
      person: { id: 99, fullName: 'Test Player' },
    });
  });

  test('getTransactionTypeBreakdown counts transaction types', async () => {
    jest
      .spyOn(transactionsService, 'getTeamTransactions')
      .mockResolvedValue([
        { date: '2026-04-20', typeCode: 'T', typeDesc: 'Trade', description: '', person: { id: 1, fullName: 'A', link: '' } },
        { date: '2026-04-21', typeCode: 'T', typeDesc: 'Trade', description: '', person: { id: 2, fullName: 'B', link: '' } },
        { date: '2026-04-22', typeCode: 'C', typeDesc: 'Claim', description: '', person: { id: 3, fullName: 'C', link: '' } },
      ] as any);

    const breakdown = await transactionsService.getTransactionTypeBreakdown(144);

    expect(Object.fromEntries(breakdown)).toEqual({
      Trade: 2,
      Claim: 1,
    });
  });
});
