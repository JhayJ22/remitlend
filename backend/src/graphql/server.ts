import { graphqlHTTP } from 'express-graphql';
import { typeDefs } from './schema.js';
import { resolvers } from './resolvers.js';
import { createDataLoaders, type DataLoaders } from './dataLoaders.js';

export interface GraphQLContext {
  loaders: DataLoaders;
}

export const createGraphQLMiddleware = () => {
  return graphqlHTTP(() => {
    const loaders = createDataLoaders();
    return {
      schema: typeDefs,
      rootValue: resolvers,
      context: {
        loaders,
      },
      graphiql: true,
      pretty: true,
    };
  });
};
