export const swaggerSchemas = {
  ValidationError: {
    type: 'object',
    properties: {
      path: { type: 'string', example: 'body.publicKey' },
      message: { type: 'string', example: 'Public key is required' },
    },
    required: ['path', 'message'],
  },
  ErrorResponse: {
    type: 'object',
    properties: {
      success: { type: 'boolean', example: false },
      message: { type: 'string', example: 'Validation failed' },
      errors: {
        type: 'array',
        items: { $ref: '#/components/schemas/ValidationError' },
      },
      stack: { type: 'string' },
    },
    required: ['success', 'message'],
  },
  SimpleSuccessResponse: {
    type: 'object',
    properties: {
      success: { type: 'boolean', example: true },
    },
    required: ['success'],
  },
  SuccessMessageResponse: {
    type: 'object',
    properties: {
      success: { type: 'boolean', example: true },
      message: { type: 'string', example: 'Webhook subscription deleted' },
    },
    required: ['success', 'message'],
  },
  ServerSentEventStream: {
    type: 'string',
    example: 'data: {"type":"init"}\n\n',
  },
  ChallengeMessage: {
    type: 'object',
    properties: {
      message: {
        type: 'string',
        example:
          'Sign this message to authenticate with RemitLend.\n\nNonce: 0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef\nTimestamp: 1700000000000\n\nThis request will expire in 5 minutes.',
      },
      nonce: {
        type: 'string',
        example: '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef',
      },
      timestamp: { type: 'integer', example: 1700000000000 },
      expiresIn: { type: 'integer', example: 300000 },
    },
    required: ['message', 'nonce', 'timestamp', 'expiresIn'],
  },
  AuthChallengeResponse: {
    type: 'object',
    properties: {
      success: { type: 'boolean', example: true },
      data: { $ref: '#/components/schemas/ChallengeMessage' },
    },
    required: ['success', 'data'],
  },
  AuthLoginData: {
    type: 'object',
    properties: {
      token: { type: 'string' },
      publicKey: { type: 'string' },
    },
    required: ['token', 'publicKey'],
  },
  AuthLoginResponse: {
    type: 'object',
    properties: {
      success: { type: 'boolean', example: true },
      data: { $ref: '#/components/schemas/AuthLoginData' },
    },
    required: ['success', 'data'],
  },
  AuthVerifyData: {
    type: 'object',
    properties: {
      publicKey: { type: 'string', nullable: true },
      role: {
        type: 'string',
        enum: ['admin', 'borrower', 'lender'],
        nullable: true,
      },
      scopes: {
        type: 'array',
        items: { type: 'string' },
      },
      valid: { type: 'boolean', example: true },
    },
    required: ['valid'],
  },
  AuthVerifyResponse: {
    type: 'object',
    properties: {
      success: { type: 'boolean', example: true },
      data: { $ref: '#/components/schemas/AuthVerifyData' },
    },
    required: ['success', 'data'],
  },
  BorrowerLoan: {
    type: 'object',
    properties: {
      loanId: { type: 'integer' },
      principal: { type: 'number' },
      accruedInterest: { type: 'number' },
      totalRepaid: { type: 'number' },
      totalOwed: { type: 'number' },
      nextPaymentDeadline: { type: 'string', format: 'date-time' },
      status: {
        type: 'string',
        enum: ['active', 'repaid', 'defaulted'],
      },
      borrower: { type: 'string' },
      approvedAt: { type: 'string', format: 'date-time', nullable: true },
    },
    required: [
      'loanId',
      'principal',
      'accruedInterest',
      'totalRepaid',
      'totalOwed',
      'nextPaymentDeadline',
      'status',
      'borrower',
    ],
  },
  BorrowerLoansResponse: {
    type: 'object',
    properties: {
      success: { type: 'boolean', example: true },
      borrower: { type: 'string' },
      loans: {
        type: 'array',
        items: { $ref: '#/components/schemas/BorrowerLoan' },
      },
    },
    required: ['success', 'borrower', 'loans'],
  },
  LoanSummaryEvent: {
    type: 'object',
    properties: {
      type: { type: 'string' },
      amount: { type: 'string', nullable: true },
      timestamp: { type: 'string', format: 'date-time', nullable: true },
      tx: { type: 'string', nullable: true },
    },
    required: ['type'],
  },
  LoanDetailsSummary: {
    type: 'object',
    properties: {
      principal: { type: 'number' },
      accruedInterest: { type: 'number' },
      totalRepaid: { type: 'number' },
      totalOwed: { type: 'number' },
      interestRate: { type: 'number' },
      termLedgers: { type: 'integer' },
      elapsedLedgers: { type: 'integer' },
      status: {
        type: 'string',
        enum: ['active', 'repaid', 'defaulted'],
      },
      requestedAt: { type: 'string', format: 'date-time', nullable: true },
      approvedAt: { type: 'string', format: 'date-time', nullable: true },
      events: {
        type: 'array',
        items: { $ref: '#/components/schemas/LoanSummaryEvent' },
      },
    },
    required: [
      'principal',
      'accruedInterest',
      'totalRepaid',
      'totalOwed',
      'interestRate',
      'termLedgers',
      'elapsedLedgers',
      'status',
      'events',
    ],
  },
  LoanDetailsResponse: {
    type: 'object',
    properties: {
      success: { type: 'boolean', example: true },
      loanId: { type: 'string' },
      summary: { $ref: '#/components/schemas/LoanDetailsSummary' },
    },
    required: ['success', 'loanId', 'summary'],
  },
  UnsignedTransactionResponse: {
    type: 'object',
    properties: {
      success: { type: 'boolean', example: true },
      unsignedTxXdr: { type: 'string' },
      networkPassphrase: { type: 'string' },
    },
    required: ['success', 'unsignedTxXdr', 'networkPassphrase'],
  },
  RepayTransactionResponse: {
    type: 'object',
    properties: {
      success: { type: 'boolean', example: true },
      loanId: { type: 'integer' },
      unsignedTxXdr: { type: 'string' },
      networkPassphrase: { type: 'string' },
    },
    required: ['success', 'loanId', 'unsignedTxXdr', 'networkPassphrase'],
  },
  SubmittedTransactionResponse: {
    type: 'object',
    properties: {
      success: { type: 'boolean', example: true },
      txHash: { type: 'string' },
      status: { type: 'string' },
      resultXdr: { type: 'string' },
    },
    required: ['success', 'txHash', 'status'],
  },
  PoolStats: {
    type: 'object',
    properties: {
      totalDeposits: { type: 'number' },
      totalOutstanding: { type: 'number' },
      utilizationRate: { type: 'number' },
      apy: { type: 'number' },
      activeLoansCount: { type: 'integer' },
    },
    required: ['totalDeposits', 'totalOutstanding', 'utilizationRate', 'apy', 'activeLoansCount'],
  },
  PoolStatsResponse: {
    type: 'object',
    properties: {
      success: { type: 'boolean', example: true },
      data: { $ref: '#/components/schemas/PoolStats' },
    },
    required: ['success', 'data'],
  },
  DepositorPortfolio: {
    type: 'object',
    properties: {
      address: { type: 'string' },
      depositAmount: { type: 'number' },
      sharePercent: { type: 'number' },
      estimatedYield: { type: 'number' },
      apy: { type: 'number' },
      firstDepositAt: { type: 'string', format: 'date-time', nullable: true },
    },
    required: ['address', 'depositAmount', 'sharePercent', 'estimatedYield', 'apy'],
  },
  DepositorPortfolioResponse: {
    type: 'object',
    properties: {
      success: { type: 'boolean', example: true },
      data: { $ref: '#/components/schemas/DepositorPortfolio' },
    },
    required: ['success', 'data'],
  },
  UserScoreFactors: {
    type: 'object',
    properties: {
      repaymentHistory: { type: 'string' },
      latePaymentPenalty: { type: 'string' },
      range: { type: 'string' },
    },
    required: ['repaymentHistory', 'latePaymentPenalty', 'range'],
  },
  UserScore: {
    type: 'object',
    properties: {
      success: { type: 'boolean', example: true },
      userId: { type: 'string' },
      score: { type: 'integer', example: 700 },
      band: {
        type: 'string',
        enum: ['Excellent', 'Good', 'Fair', 'Poor'],
      },
      factors: { $ref: '#/components/schemas/UserScoreFactors' },
    },
    required: ['success', 'userId', 'score', 'band', 'factors'],
  },
  ScoreUpdateResponse: {
    type: 'object',
    properties: {
      success: { type: 'boolean', example: true },
      userId: { type: 'string' },
      repaymentAmount: { type: 'number' },
      onTime: { type: 'boolean' },
      oldScore: { type: 'integer' },
      delta: { type: 'integer' },
      newScore: { type: 'integer' },
      band: {
        type: 'string',
        enum: ['Excellent', 'Good', 'Fair', 'Poor'],
      },
    },
    required: [
      'success',
      'userId',
      'repaymentAmount',
      'onTime',
      'oldScore',
      'delta',
      'newScore',
      'band',
    ],
  },
  ScoreBreakdownMetrics: {
    type: 'object',
    properties: {
      totalLoans: { type: 'integer' },
      repaidOnTime: { type: 'integer' },
      repaidLate: { type: 'integer' },
      defaulted: { type: 'integer' },
      totalRepaid: { type: 'number' },
      averageRepaymentTime: { type: 'string' },
      longestStreak: { type: 'integer' },
      currentStreak: { type: 'integer' },
    },
    required: [
      'totalLoans',
      'repaidOnTime',
      'repaidLate',
      'defaulted',
      'totalRepaid',
      'averageRepaymentTime',
      'longestStreak',
      'currentStreak',
    ],
  },
  ScoreHistoryEntry: {
    type: 'object',
    properties: {
      date: { type: 'string', nullable: true },
      score: { type: 'integer' },
      event: { type: 'string' },
    },
    required: ['date', 'score', 'event'],
  },
  ScoreBreakdownResponse: {
    type: 'object',
    properties: {
      success: { type: 'boolean', example: true },
      userId: { type: 'string' },
      score: { type: 'integer' },
      band: {
        type: 'string',
        enum: ['Excellent', 'Good', 'Fair', 'Poor'],
      },
      breakdown: { $ref: '#/components/schemas/ScoreBreakdownMetrics' },
      history: {
        type: 'array',
        items: { $ref: '#/components/schemas/ScoreHistoryEntry' },
      },
    },
    required: ['success', 'userId', 'score', 'band', 'breakdown', 'history'],
  },
  RemittanceHistoryEntry: {
    type: 'object',
    properties: {
      month: { type: 'string' },
      amount: { type: 'number' },
      status: { type: 'string', enum: ['Completed', 'Defaulted'] },
    },
    required: ['month', 'amount', 'status'],
  },
  RemittanceHistory: {
    type: 'object',
    properties: {
      userId: { type: 'string' },
      score: { type: 'integer' },
      streak: { type: 'integer' },
      history: {
        type: 'array',
        items: { $ref: '#/components/schemas/RemittanceHistoryEntry' },
      },
    },
    required: ['userId', 'score', 'streak', 'history'],
  },
  SimulatePaymentResponse: {
    type: 'object',
    properties: {
      success: { type: 'boolean', example: true },
      message: { type: 'string' },
      newScore: { type: 'integer' },
    },
    required: ['success', 'message', 'newScore'],
  },
  Notification: {
    type: 'object',
    properties: {
      id: { type: 'integer' },
      userId: { type: 'string' },
      type: {
        type: 'string',
        enum: [
          'loan_approved',
          'repayment_due',
          'repayment_confirmed',
          'loan_defaulted',
          'loan_liquidated',
          'score_changed',
        ],
      },
      title: { type: 'string' },
      message: { type: 'string' },
      loanId: { type: 'integer' },
      actionUrl: { type: 'string', nullable: true },
      read: { type: 'boolean' },
      createdAt: { type: 'string', format: 'date-time' },
    },
    required: ['id', 'userId', 'type', 'title', 'message', 'read', 'createdAt'],
  },
  NotificationsData: {
    type: 'object',
    properties: {
      notifications: {
        type: 'array',
        items: { $ref: '#/components/schemas/Notification' },
      },
      unreadCount: { type: 'integer' },
    },
    required: ['notifications', 'unreadCount'],
  },
  NotificationsResponse: {
    type: 'object',
    properties: {
      success: { type: 'boolean', example: true },
      data: { $ref: '#/components/schemas/NotificationsData' },
    },
    required: ['success', 'data'],
  },
  NotificationPreferences: {
    type: 'object',
    properties: {
      emailEnabled: { type: 'boolean', example: true },
      smsEnabled: { type: 'boolean', example: false },
      phone: {
        type: 'string',
        nullable: true,
        example: '+14155552671',
      },
      perTypeOverrides: {
        type: 'object',
        additionalProperties: { type: 'boolean' },
      },
    },
    required: ['emailEnabled', 'smsEnabled', 'phone', 'perTypeOverrides'],
  },
  EventConnectionCounts: {
    type: 'object',
    properties: {
      borrower: { type: 'integer' },
      admin: { type: 'integer' },
      total: { type: 'integer' },
    },
    required: ['borrower', 'admin', 'total'],
  },
  EventStreamStatusResponse: {
    type: 'object',
    properties: {
      success: { type: 'boolean', example: true },
      data: { $ref: '#/components/schemas/EventConnectionCounts' },
    },
    required: ['success', 'data'],
  },
  LoanEventRecord: {
    type: 'object',
    properties: {
      eventId: { type: 'string' },
      eventType: {
        type: 'string',
        enum: [
          'LoanRequested',
          'LoanApproved',
          'LoanRepaid',
          'LoanDefaulted',
          'Seized',
          'Paused',
          'Unpaused',
          'MinScoreUpdated',
        ],
      },
      loanId: { type: 'integer' },
      borrower: { type: 'string' },
      amount: { type: 'string' },
      ledger: { type: 'integer' },
      ledgerClosedAt: { type: 'string', format: 'date-time' },
      txHash: { type: 'string' },
      createdAt: { type: 'string', format: 'date-time' },
      interestRateBps: { type: 'integer' },
      termLedgers: { type: 'integer' },
      contractId: { type: 'string' },
      topics: {
        type: 'array',
        items: { type: 'string' },
      },
      value: { type: 'string' },
    },
    required: ['eventId', 'eventType', 'borrower', 'ledger', 'ledgerClosedAt', 'txHash'],
  },
  Pagination: {
    description:
      'Cursor-based pagination envelope. See the ' +
      '[pagination contract](../../../docs/pagination-contract.md) for the full ' +
      'contract: offset semantics, maximum limit cap, and total count behaviour.',
    type: 'object',
    properties: {
      total: { type: 'integer' },
      limit: { type: 'integer' },
      offset: { type: 'integer' },
    },
    required: ['total', 'limit', 'offset'],
  },
  BorrowerEventsData: {
    type: 'object',
    properties: {
      events: {
        type: 'array',
        items: { $ref: '#/components/schemas/LoanEventRecord' },
      },
      pagination: { $ref: '#/components/schemas/Pagination' },
    },
    required: ['events', 'pagination'],
  },
  BorrowerEventsResponse: {
    type: 'object',
    properties: {
      success: { type: 'boolean', example: true },
      data: { $ref: '#/components/schemas/BorrowerEventsData' },
    },
    required: ['success', 'data'],
  },
  LoanEventsData: {
    type: 'object',
    properties: {
      loanId: { type: 'integer' },
      events: {
        type: 'array',
        items: { $ref: '#/components/schemas/LoanEventRecord' },
      },
    },
    required: ['loanId', 'events'],
  },
  LoanEventsResponse: {
    type: 'object',
    properties: {
      success: { type: 'boolean', example: true },
      data: { $ref: '#/components/schemas/LoanEventsData' },
    },
    required: ['success', 'data'],
  },
  RecentEventsData: {
    type: 'object',
    properties: {
      events: {
        type: 'array',
        items: { $ref: '#/components/schemas/LoanEventRecord' },
      },
    },
    required: ['events'],
  },
  RecentEventsResponse: {
    type: 'object',
    properties: {
      success: { type: 'boolean', example: true },
      data: { $ref: '#/components/schemas/RecentEventsData' },
    },
    required: ['success', 'data'],
  },
  IndexerStatusData: {
    type: 'object',
    properties: {
      lastIndexedLedger: { type: 'integer' },
      lastIndexedCursor: { type: 'string', nullable: true },
      lastUpdated: { type: 'string', format: 'date-time' },
      totalEvents: { type: 'integer' },
      eventsByType: {
        type: 'object',
        additionalProperties: { type: 'integer' },
      },
    },
    required: [
      'lastIndexedLedger',
      'lastIndexedCursor',
      'lastUpdated',
      'totalEvents',
      'eventsByType',
    ],
  },
  IndexerStatusResponse: {
    type: 'object',
    properties: {
      success: { type: 'boolean', example: true },
      data: { $ref: '#/components/schemas/IndexerStatusData' },
    },
    required: ['success', 'data'],
  },
  WebhookSubscription: {
    type: 'object',
    properties: {
      id: { type: 'integer' },
      callbackUrl: { type: 'string', format: 'uri' },
      eventTypes: {
        type: 'array',
        items: {
          type: 'string',
          enum: [
            'LoanRequested',
            'LoanApproved',
            'LoanRepaid',
            'LoanDefaulted',
            'Seized',
            'Paused',
            'Unpaused',
            'MinScoreUpdated',
          ],
        },
      },
      secret: { type: 'string' },
      isActive: { type: 'boolean' },
      createdAt: { type: 'string', format: 'date-time' },
      updatedAt: { type: 'string', format: 'date-time' },
    },
    required: ['id', 'callbackUrl', 'eventTypes', 'isActive', 'createdAt', 'updatedAt'],
  },
  WebhookSubscriptionListData: {
    type: 'object',
    properties: {
      subscriptions: {
        type: 'array',
        items: { $ref: '#/components/schemas/WebhookSubscription' },
      },
    },
    required: ['subscriptions'],
  },
  WebhookSubscriptionListResponse: {
    type: 'object',
    properties: {
      success: { type: 'boolean', example: true },
      data: { $ref: '#/components/schemas/WebhookSubscriptionListData' },
    },
    required: ['success', 'data'],
  },
  WebhookSubscriptionData: {
    type: 'object',
    properties: {
      subscription: { $ref: '#/components/schemas/WebhookSubscription' },
    },
    required: ['subscription'],
  },
  WebhookSubscriptionResponse: {
    type: 'object',
    properties: {
      success: { type: 'boolean', example: true },
      data: { $ref: '#/components/schemas/WebhookSubscriptionData' },
    },
    required: ['success', 'data'],
  },
  WebhookDelivery: {
    type: 'object',
    properties: {
      id: { type: 'integer' },
      subscriptionId: { type: 'integer' },
      eventId: { type: 'string' },
      eventType: {
        type: 'string',
        enum: [
          'LoanRequested',
          'LoanApproved',
          'LoanRepaid',
          'LoanDefaulted',
          'Seized',
          'Paused',
          'Unpaused',
          'MinScoreUpdated',
        ],
      },
      attemptCount: { type: 'integer' },
      lastStatusCode: { type: 'integer' },
      lastError: { type: 'string' },
      deliveredAt: { type: 'string', format: 'date-time' },
      createdAt: { type: 'string', format: 'date-time' },
      updatedAt: { type: 'string', format: 'date-time' },
    },
    required: [
      'id',
      'subscriptionId',
      'eventId',
      'eventType',
      'attemptCount',
      'createdAt',
      'updatedAt',
    ],
  },
  WebhookDeliveriesData: {
    type: 'object',
    properties: {
      subscriptionId: { type: 'integer' },
      deliveries: {
        type: 'array',
        items: { $ref: '#/components/schemas/WebhookDelivery' },
      },
    },
    required: ['subscriptionId', 'deliveries'],
  },
  WebhookDeliveriesResponse: {
    type: 'object',
    properties: {
      success: { type: 'boolean', example: true },
      data: { $ref: '#/components/schemas/WebhookDeliveriesData' },
    },
    required: ['success', 'data'],
  },
  ReindexResult: {
    type: 'object',
    properties: {
      fromLedger: { type: 'integer' },
      toLedger: { type: 'integer' },
      fetchedEvents: { type: 'integer' },
      insertedEvents: { type: 'integer' },
      lastProcessedLedger: { type: 'integer' },
    },
    required: ['fromLedger', 'toLedger', 'fetchedEvents', 'insertedEvents', 'lastProcessedLedger'],
  },
  ReindexResponse: {
    type: 'object',
    properties: {
      success: { type: 'boolean', example: true },
      data: { $ref: '#/components/schemas/ReindexResult' },
    },
    required: ['success', 'data'],
  },
  DefaultCheckBatchResult: {
    type: 'object',
    properties: {
      loanIds: {
        type: 'array',
        maxItems: 1000,
        items: { type: 'integer' },
      },
      txHash: { type: 'string' },
      submitStatus: { type: 'string' },
      txStatus: { type: 'string' },
      error: { type: 'string' },
    },
    required: ['loanIds'],
  },
  DefaultCheckRunResult: {
    type: 'object',
    properties: {
      runId: { type: 'string' },
      currentLedger: { type: 'integer' },
      termLedgers: { type: 'integer' },
      overdueCount: { type: 'integer' },
      oldestDueLedger: { type: 'integer' },
      ledgersPastOldestDue: { type: 'integer' },
      batches: {
        type: 'array',
        items: { $ref: '#/components/schemas/DefaultCheckBatchResult' },
      },
    },
    required: ['runId', 'currentLedger', 'termLedgers', 'overdueCount', 'batches'],
  },
  DefaultCheckResponse: {
    type: 'object',
    properties: {
      success: { type: 'boolean', example: true },
      data: { $ref: '#/components/schemas/DefaultCheckRunResult' },
    },
    required: ['success', 'data'],
  },
  // Error handling schemas for structured error codes (Issue #371)
  ErrorCode: {
    type: 'string',
    enum: [
      'INVALID_AMOUNT',
      'INVALID_PUBLIC_KEY',
      'INVALID_SIGNATURE',
      'INVALID_CHALLENGE',
      'MISSING_FIELD',
      'VALIDATION_ERROR',
      'UNAUTHORIZED',
      'TOKEN_EXPIRED',
      'TOKEN_INVALID',
      'CHALLENGE_EXPIRED',
      'FORBIDDEN',
      'ACCESS_DENIED',
      'BORROWER_MISMATCH',
      'NOT_FOUND',
      'LOAN_NOT_FOUND',
      'USER_NOT_FOUND',
      'POOL_NOT_FOUND',
      'CONFLICT',
      'DUPLICATE_REQUEST',
      'RATE_LIMIT_EXCEEDED',
      'INTERNAL_ERROR',
      'DATABASE_ERROR',
      'EXTERNAL_SERVICE_ERROR',
      'BLOCKCHAIN_ERROR',
      'INSUFFICIENT_BALANCE',
      'LOAN_ALREADY_REPAID',
      'LOAN_NOT_ACTIVE',
      'INVALID_LOAN_ID',
      'INVALID_TX_XDR',
    ],
    description: 'Machine-readable error code for programmatic handling',
  },
  ErrorField: {
    type: 'object',
    properties: {
      code: { $ref: '#/components/schemas/ErrorCode' },
      message: { type: 'string', example: 'Amount must be a positive number' },
      field: {
        type: 'string',
        example: 'amount',
        description: 'The field that caused the error (if applicable)',
      },
      details: {
        type: 'object',
        description: 'Additional error details (if applicable)',
      },
    },
    required: ['code', 'message'],
  },
  StructuredErrorResponse: {
    type: 'object',
    properties: {
      success: { type: 'boolean', example: false },
      message: { type: 'string', example: 'Validation failed' },
      errors: {
        type: 'array',
        items: { $ref: '#/components/schemas/ValidationError' },
      },
      error: { $ref: '#/components/schemas/ErrorField' },
      field: { type: 'string' },
    },
    required: ['success', 'error'],
  },
  // ---------------------------------------------------------------------------
  // Operations schemas (Issues #863, #867, #868)
  //
  // All operations endpoints are admin-only (RBAC: `admin` role, scope
  // `operations:read` for GETs and `operations:write` for mutations). Every
  // mutation is idempotent via an `Idempotency-Key` header; replays return the
  // original response with `idempotentReplay: true`. Timestamps are always
  // ISO-8601 UTC strings and are never derived from client-supplied clocks.
  // ---------------------------------------------------------------------------
  AlertSeverity: {
    type: 'string',
    enum: ['critical', 'high', 'warning'],
    description: 'Severity of an SLO alert. Only `critical` alerts page on-call.',
  },
  AlertOwner: {
    type: 'object',
    properties: {
      team: { type: 'string', example: 'payments-oncall' },
      primary: { type: 'string', example: 'alice@example.com' },
      secondary: { type: 'string', nullable: true, example: 'bob@example.com' },
      escalationPolicyId: { type: 'string', example: 'pol_fin_slo_v1' },
    },
    required: ['team', 'primary', 'escalationPolicyId'],
  },
  AlertOwnership: {
    type: 'object',
    properties: {
      alertId: { type: 'string', example: 'slo.financial.settlement_latency' },
      sloId: { type: 'string', example: 'slo.settlement_latency_p99' },
      severity: { $ref: '#/components/schemas/AlertSeverity' },
      owner: { $ref: '#/components/schemas/AlertOwner' },
      runbookUrl: { type: 'string', format: 'uri' },
      escalationRoute: {
        type: 'array',
        description: 'Ordered escalation steps; index 0 is the first responder.',
        items: {
          type: 'object',
          properties: {
            afterMinutes: { type: 'integer', minimum: 0 },
            notify: { type: 'string', example: 'pagerduty:payments-oncall' },
          },
          required: ['afterMinutes', 'notify'],
        },
      },
      updatedAt: { type: 'string', format: 'date-time' },
      updatedBy: { type: 'string' },
    },
    required: [
      'alertId',
      'sloId',
      'severity',
      'owner',
      'runbookUrl',
      'escalationRoute',
      'updatedAt',
      'updatedBy',
    ],
  },
  AlertOwnershipListResponse: {
    type: 'object',
    properties: {
      success: { type: 'boolean', example: true },
      data: {
        type: 'object',
        properties: {
          alerts: {
            type: 'array',
            items: { $ref: '#/components/schemas/AlertOwnership' },
          },
        },
        required: ['alerts'],
      },
    },
    required: ['success', 'data'],
  },
  AlertOwnershipUpsertRequest: {
    type: 'object',
    properties: {
      severity: { $ref: '#/components/schemas/AlertSeverity' },
      owner: { $ref: '#/components/schemas/AlertOwner' },
      runbookUrl: { type: 'string', format: 'uri' },
      escalationRoute: {
        type: 'array',
        minItems: 1,
        items: {
          type: 'object',
          properties: {
            afterMinutes: { type: 'integer', minimum: 0 },
            notify: { type: 'string' },
          },
          required: ['afterMinutes', 'notify'],
        },
      },
      expectedVersion: {
        type: 'integer',
        minimum: 1,
        description:
          'Optimistic concurrency guard. Stale versions are rejected with 409 CONFLICT and no partial write.',
      },
    },
    required: ['severity', 'owner', 'runbookUrl', 'escalationRoute', 'expectedVersion'],
  },
  AlertOwnershipResponse: {
    type: 'object',
    properties: {
      success: { type: 'boolean', example: true },
      data: { $ref: '#/components/schemas/AlertOwnership' },
      idempotentReplay: { type: 'boolean', example: false },
    },
    required: ['success', 'data'],
  },
  NotificationDeliveryTestRequest: {
    type: 'object',
    properties: {
      alertId: { type: 'string' },
      channel: { type: 'string', enum: ['pagerduty', 'slack', 'email', 'webhook'] },
      dryRun: {
        type: 'boolean',
        default: true,
        description: 'When true no external notification is sent; delivery is simulated.',
      },
    },
    required: ['alertId', 'channel'],
  },
  NotificationDeliveryTestResult: {
    type: 'object',
    properties: {
      alertId: { type: 'string' },
      channel: { type: 'string' },
      delivered: { type: 'boolean' },
      providerStatusCode: { type: 'integer', nullable: true },
      latencyMs: { type: 'integer' },
      attemptedAt: { type: 'string', format: 'date-time' },
      error: { type: 'string', nullable: true },
    },
    required: ['alertId', 'channel', 'delivered', 'latencyMs', 'attemptedAt'],
  },
  NotificationDeliveryTestResponse: {
    type: 'object',
    properties: {
      success: { type: 'boolean', example: true },
      data: { $ref: '#/components/schemas/NotificationDeliveryTestResult' },
    },
    required: ['success', 'data'],
  },
  AlertDrillRequest: {
    type: 'object',
    properties: {
      alertIds: {
        type: 'array',
        minItems: 1,
        maxItems: 50,
        items: { type: 'string' },
      },
      scheduledFor: {
        type: 'string',
        format: 'date-time',
        description: 'Must be in the future; past timestamps are rejected with 422.',
      },
      acknowledgeWithinMinutes: { type: 'integer', minimum: 1, maximum: 120, default: 15 },
    },
    required: ['alertIds', 'scheduledFor'],
  },
  AlertDrillResult: {
    type: 'object',
    properties: {
      drillId: { type: 'string' },
      status: {
        type: 'string',
        enum: ['scheduled', 'running', 'completed', 'failed', 'cancelled'],
      },
      scheduledFor: { type: 'string', format: 'date-time' },
      startedAt: { type: 'string', format: 'date-time', nullable: true },
      completedAt: { type: 'string', format: 'date-time', nullable: true },
      alerts: {
        type: 'array',
        items: {
          type: 'object',
          properties: {
            alertId: { type: 'string' },
            notified: { type: 'boolean' },
            acknowledgedAt: { type: 'string', format: 'date-time', nullable: true },
            acknowledgedBy: { type: 'string', nullable: true },
            recoveredAt: { type: 'string', format: 'date-time', nullable: true },
            timeToAcknowledgeSeconds: { type: 'integer', nullable: true },
            timeToRecoverSeconds: { type: 'integer', nullable: true },
          },
          required: ['alertId', 'notified'],
        },
      },
    },
    required: ['drillId', 'status', 'scheduledFor', 'alerts'],
  },
  AlertDrillResponse: {
    type: 'object',
    properties: {
      success: { type: 'boolean', example: true },
      data: { $ref: '#/components/schemas/AlertDrillResult' },
      idempotentReplay: { type: 'boolean', example: false },
    },
    required: ['success', 'data'],
  },
  IncidentEvidenceBundleRequest: {
    type: 'object',
    properties: {
      incidentId: { type: 'string', example: 'inc_2024_06_01_001' },
      from: { type: 'string', format: 'date-time' },
      to: { type: 'string', format: 'date-time' },
      include: {
        type: 'array',
        items: {
          type: 'string',
          enum: ['requests', 'traces', 'checkpoints', 'stateRefs'],
        },
        default: ['requests', 'traces', 'checkpoints', 'stateRefs'],
      },
      redactionMode: {
        type: 'string',
        enum: ['default', 'strict'],
        default: 'default',
        description:
          'Redaction is applied by default. `strict` additionally removes all free-text fields.',
      },
      ttlSeconds: {
        type: 'integer',
        minimum: 60,
        maximum: 86400,
        default: 3600,
        description: 'Bundle lifetime. Expired bundles return 410 Gone.',
      },
    },
    required: ['incidentId', 'from', 'to'],
  },
  IncidentEvidenceBundle: {
    type: 'object',
    properties: {
      bundleId: { type: 'string' },
      incidentId: { type: 'string' },
      createdAt: { type: 'string', format: 'date-time' },
      expiresAt: { type: 'string', format: 'date-time' },
      redactionMode: { type: 'string', enum: ['default', 'strict'] },
      redactedFields: {
        type: 'array',
        items: { type: 'string' },
      },
      entries: {
        type: 'array',
        items: {
          type: 'object',
          properties: {
            kind: {
              type: 'string',
              enum: ['request', 'trace', 'checkpoint', 'stateRef'],
            },
            ref: { type: 'string' },
            occurredAt: { type: 'string', format: 'date-time' },
            payload: {
              type: 'object',
              description: 'Redacted payload; never contains secrets or PII.',
            },
          },
          required: ['kind', 'ref', 'occurredAt'],
        },
      },
      reproducible: {
        type: 'boolean',
        description: 'True when the bundle can be regenerated from the incident ID alone.',
      },
    },
    required: [
      'bundleId',
      'incidentId',
      'createdAt',
      'expiresAt',
      'redactionMode',
      'entries',
      'reproducible',
    ],
  },
  IncidentEvidenceBundleResponse: {
    type: 'object',
    properties: {
      success: { type: 'boolean', example: true },
      data: { $ref: '#/components/schemas/IncidentEvidenceBundle' },
      idempotentReplay: { type: 'boolean', example: false },
    },
    required: ['success', 'data'],
  },
  ClockSkewSample: {
    type: 'object',
    properties: {
      service: { type: 'string', example: 'backend' },
      provider: { type: 'string', example: 'stellar-horizon' },
      observedAt: { type: 'string', format: 'date-time' },
      offsetMs: { type: 'integer', example: 42 },
      roundTripMs: { type: 'integer', example: 18 },
      thresholdMs: { type: 'integer', example: 500 },
      breached: { type: 'boolean' },
    },
    required: ['service', 'provider', 'observedAt', 'offsetMs', 'roundTripMs', 'thresholdMs', 'breached'],
  },
  ClockSkewReport: {
    type: 'object',
    properties: {
      generatedAt: { type: 'string', format: 'date-time' },
      samples: {
        type: 'array',
        items: { $ref: '#/components/schemas/ClockSkewSample' },
      },
      authoritativeTimestamps: {
        type: 'array',
        description: 'Authoritative timestamp source per workflow.',
        items: {
          type: 'object',
          properties: {
            workflow: { type: 'string', example: 'quote' },
            source: { type: 'string', example: 'backend.server_clock' },
            maxSkewMs: { type: 'integer', example: 500 },
          },
          required: ['workflow', 'source', 'maxSkewMs'],
        },
      },
    },
    required: ['generatedAt', 'samples', 'authoritativeTimestamps'],
  },
  ClockSkewReportResponse: {
    type: 'object',
    properties: {
      success: { type: 'boolean', example: true },
      data: { $ref: '#/components/schemas/ClockSkewReport' },
    },
    required: ['success', 'data'],
  },
} as const;
