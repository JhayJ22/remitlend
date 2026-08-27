import { buildSchema } from 'graphql';

export const typeDefs = buildSchema(`
  type Query {
    loan(id: String!): Loan
    loans(limit: Int, offset: Int): LoanConnection!
    score(address: String!): Score
    scores(limit: Int, offset: Int): ScoreConnection!
    remittance(id: String!): Remittance
    remittances(limit: Int, offset: Int): RemittanceConnection!
    poolBalance(token: String!): String
    totalOutstanding(token: String!): String
  }

  type Loan {
    id: String!
    borrower: String!
    amount: String!
    principal_paid: String!
    interest_paid: String!
    accrued_interest: String!
    interest_rate_bps: Int!
    due_date: Int!
    status: String!
    collateral_amount: String!
    created_at: String
    updated_at: String
  }

  type LoanConnection {
    edges: [Loan!]!
    total: Int!
  }

  type Score {
    address: String!
    score: Int!
    updated_at: String
  }

  type ScoreConnection {
    edges: [Score!]!
    total: Int!
  }

  type Remittance {
    id: String!
    recipient: String!
    amount: String!
    status: String!
    metadata_uri: String
    created_at: String
    updated_at: String
  }

  type RemittanceConnection {
    edges: [Remittance!]!
    total: Int!
  }
`);
