import { handler } from '../index.js';

describe('helpscoutSavedRepliesStandalone handler', () => {
  let previousMailboxId;
  let previousClientId;
  let previousClientSecret;
  let previousTokenCache;
  let previousReportExceptions;

  beforeEach(() => {
    previousMailboxId = process.env.HELPSCOUT_MAILBOX_ID;
    previousClientId = process.env.HELPSCOUT_CLIENT_ID;
    previousClientSecret = process.env.HELPSCOUT_CLIENT_SECRET;
    previousTokenCache = global.helpscoutTokenCache;
    previousReportExceptions = global.reportExceptions;

    process.env.HELPSCOUT_MAILBOX_ID = 'mailbox-123';
    process.env.HELPSCOUT_CLIENT_ID = 'client-id';
    process.env.HELPSCOUT_CLIENT_SECRET = 'client-secret';

    global.helpscoutTokenCache = { token: null, timestamp: 0 };

    spyOn(console, 'log');
    spyOn(console, 'error');
  });

  afterEach(() => {
    process.env.HELPSCOUT_MAILBOX_ID = previousMailboxId;
    process.env.HELPSCOUT_CLIENT_ID = previousClientId;
    process.env.HELPSCOUT_CLIENT_SECRET = previousClientSecret;
    global.helpscoutTokenCache = previousTokenCache;
    global.reportExceptions = previousReportExceptions;
  });

  it('should export a handler function', () => {
    expect(typeof handler).toBe('function');
  });

  it('should write saved_replies.json when Help Scout returns reply details', async () => {
    const mockLoggedHttp = jasmine.createSpy('loggedHttp').and.callFake(async (url) => {
      const reqUrl = String(url);

      if (reqUrl.includes('helpscout.net/v2/oauth2/token')) {
        return { access_token: 'mock-token' };
      }

      if (/\/mailboxes\/[^/]+\/saved-replies$/.test(reqUrl)) {
        return [
          {
            id: 123,
            _links: {
              self: {
                href: 'https://api.helpscout.net/v2/saved-replies/123'
              }
            }
          }
        ];
      }

      if (reqUrl.includes('/mailboxes/mailbox-123/saved-replies/123')) {
        const err = new Error('not found');
        err.response = { status: 404 };
        throw err;
      }

      if (reqUrl.includes('/saved-replies/123')) {
        return {
          id: 123,
          name: 'Reply 123',
          chatText: 'private text'
        };
      }

      throw new Error(`unexpected URL ${reqUrl}`);
    });

    const mockS3 = {
      send: jasmine.createSpy('send').and.resolveTo({})
    };

    const result = await handler({}, {}, { loggedHttp: mockLoggedHttp, s3: mockS3 });

    expect(result.statusCode).toBe(200);
    const savedRepliesCall = mockS3.send.calls.allArgs().find(([command]) => command?.input?.Key === 'saved_replies.json');
    expect(savedRepliesCall).toBeDefined();

    const savedRepliesCommand = savedRepliesCall[0];
    expect(JSON.parse(savedRepliesCommand.input.Body)).toEqual([
      {
        id: 123,
        name: 'Reply 123',
        chatText: 'private text'
      }
    ]);
  });

  it('should skip S3 write when saved replies list is empty', async () => {
    const mockLoggedHttp = jasmine.createSpy('loggedHttp').and.callFake(async (url) => {
      const reqUrl = String(url);

      if (reqUrl.includes('helpscout.net/v2/oauth2/token')) {
        return { access_token: 'mock-token' };
      }

      if (/\/mailboxes\/[^/]+\/saved-replies$/.test(reqUrl)) {
        return { _embedded: { savedReplies: [] } };
      }

      throw new Error(`unexpected URL ${reqUrl}`);
    });

    const mockS3 = {
      send: jasmine.createSpy('send').and.resolveTo({})
    };

    const result = await handler({}, {}, { loggedHttp: mockLoggedHttp, s3: mockS3 });

    expect(result.statusCode).toBe(200);
    expect(mockS3.send).not.toHaveBeenCalled();
  });

  it('should follow pagination links when listing saved replies', async () => {
    const pageOneUrl = 'https://api.helpscout.net/v2/mailboxes/mailbox-123/saved-replies';
    const pageTwoUrl = `${pageOneUrl}?page=2`;

    const mockLoggedHttp = jasmine.createSpy('loggedHttp').and.callFake(async (url) => {
      const reqUrl = String(url);

      if (reqUrl.includes('helpscout.net/v2/oauth2/token')) {
        return { access_token: 'mock-token' };
      }

      if (reqUrl === pageOneUrl) {
        return {
          _embedded: {
            savedReplies: [{ id: 101 }, { id: 102 }]
          },
          _links: {
            next: { href: pageTwoUrl }
          }
        };
      }

      if (reqUrl === pageTwoUrl) {
        return {
          _embedded: {
            savedReplies: [{ id: 103 }]
          },
          _links: {}
        };
      }

      if (reqUrl.includes('/mailboxes/mailbox-123/saved-replies/101')) {
        return { id: 101, name: 'Reply 101' };
      }

      if (reqUrl.includes('/mailboxes/mailbox-123/saved-replies/102')) {
        return { id: 102, name: 'Reply 102' };
      }

      if (reqUrl.includes('/mailboxes/mailbox-123/saved-replies/103')) {
        return { id: 103, name: 'Reply 103' };
      }

      throw new Error(`unexpected URL ${reqUrl}`);
    });

    const mockS3 = {
      send: jasmine.createSpy('send').and.resolveTo({})
    };

    const result = await handler({}, {}, { loggedHttp: mockLoggedHttp, s3: mockS3 });

    expect(result.statusCode).toBe(200);

    const savedRepliesCall = mockS3.send.calls.allArgs().find(([command]) => command?.input?.Key === 'saved_replies.json');
    expect(savedRepliesCall).toBeDefined();

    const savedRepliesCommand = savedRepliesCall[0];
    expect(JSON.parse(savedRepliesCommand.input.Body)).toEqual([
      { id: 101, name: 'Reply 101' },
      { id: 102, name: 'Reply 102' },
      { id: 103, name: 'Reply 103' }
    ]);

    const calledUrls = mockLoggedHttp.calls.allArgs().map(([url]) => String(url));
    expect(calledUrls).toContain(pageOneUrl);
    expect(calledUrls).toContain(pageTwoUrl);
  });

  it('should report and throw when fetching the saved replies list fails', async () => {
    const mockLoggedHttp = jasmine.createSpy('loggedHttp').and.callFake(async (url) => {
      const reqUrl = String(url);

      if (reqUrl.includes('helpscout.net/v2/oauth2/token')) {
        return { access_token: 'mock-token' };
      }

      if (/\/mailboxes\/[^/]+\/saved-replies$/.test(reqUrl)) {
        throw new Error('saved replies list failed');
      }

      throw new Error(`unexpected URL ${reqUrl}`);
    });

    const mockS3 = {
      send: jasmine.createSpy('send').and.resolveTo({})
    };

    const mockReportExceptions = jasmine.createSpy('reportExceptions').and.resolveTo();

    let thrownError;
    try {
      await handler({}, {}, { loggedHttp: mockLoggedHttp, s3: mockS3, reportExceptions: mockReportExceptions });
    } catch (err) {
      thrownError = err;
    }

    expect(thrownError).toBeDefined();
    expect(mockReportExceptions).toHaveBeenCalled();
    expect(mockS3.send).not.toHaveBeenCalled();
  });

  it('should fail on detail fetch error and report exactly once', async () => {
    const mockLoggedHttp = jasmine.createSpy('loggedHttp').and.callFake(async (url) => {
      const reqUrl = String(url);

      if (reqUrl.includes('helpscout.net/v2/oauth2/token')) {
        return { access_token: 'mock-token' };
      }

      if (/\/mailboxes\/[^/]+\/saved-replies$/.test(reqUrl)) {
        return [
          {
            id: 999,
            _links: {
              self: {
                href: 'https://api.helpscout.net/v2/saved-replies/999'
              }
            }
          }
        ];
      }

      if (reqUrl.includes('/saved-replies/999')) {
        throw new Error('detail fetch failed');
      }

      throw new Error(`unexpected URL ${reqUrl}`);
    });

    const mockS3 = {
      send: jasmine.createSpy('send').and.resolveTo({})
    };

    const mockReportExceptions = jasmine.createSpy('reportExceptions').and.resolveTo();

    let thrownError;
    try {
      await handler({}, {}, { loggedHttp: mockLoggedHttp, s3: mockS3, reportExceptions: mockReportExceptions });
    } catch (err) {
      thrownError = err;
    }

    expect(thrownError).toBeDefined();
    expect(mockReportExceptions).toHaveBeenCalledTimes(1);
    expect(mockS3.send).not.toHaveBeenCalled();
  });

  it('should rate limit detail fetches to 2 calls per second', async () => {
    let fakeNow = 0;
    const sleepCalls = [];
    const mockSleep = jasmine.createSpy('sleep').and.callFake(async (ms) => {
      sleepCalls.push(ms);
      fakeNow += ms;
    });
    const now = () => fakeNow;

    const mockLoggedHttp = jasmine.createSpy('loggedHttp').and.callFake(async (url) => {
      const reqUrl = String(url);

      if (reqUrl.includes('helpscout.net/v2/oauth2/token')) {
        return { access_token: 'mock-token' };
      }

      if (/\/mailboxes\/[^/]+\/saved-replies$/.test(reqUrl)) {
        return [{ id: 1 }, { id: 2 }, { id: 3 }];
      }

      if (reqUrl.includes('/mailboxes/mailbox-123/saved-replies/1')) {
        return { id: 1, name: 'Reply 1' };
      }

      if (reqUrl.includes('/mailboxes/mailbox-123/saved-replies/2')) {
        return { id: 2, name: 'Reply 2' };
      }

      if (reqUrl.includes('/mailboxes/mailbox-123/saved-replies/3')) {
        return { id: 3, name: 'Reply 3' };
      }

      throw new Error(`unexpected URL ${reqUrl}`);
    });

    const mockS3 = {
      send: jasmine.createSpy('send').and.resolveTo({})
    };

    const result = await handler({}, {}, {
      loggedHttp: mockLoggedHttp,
      s3: mockS3,
      sleep: mockSleep,
      now,
      savedRepliesRateLimitMs: 500
    });

    expect(result.statusCode).toBe(200);
    expect(mockSleep).toHaveBeenCalledTimes(2);
    expect(sleepCalls).toEqual([500, 500]);
  });
});
