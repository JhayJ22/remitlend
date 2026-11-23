#!/usr/bin/env node
/**
 * Automated OpenAPI route parity check (#776)
 * Validates that all Express route handlers are documented in the OpenAPI spec
 * and that all documented paths correspond to actual route handlers.
 */

import { swaggerSpec } from '../backend/src/config/swagger.js';
import app from '../backend/src/app.js';

function extractExpressRoutes(app) {
  const routes = [];
  function processMiddleware(middleware, basePath = '') {
    if (middleware.route) {
      const path = (basePath + middleware.route.path).replace(/\/+/g, '/');
      const methods = Object.keys(middleware.route.methods).map((m) => m.toLowerCase());
      for (const method of methods) {
        routes.push({ method, path });
      }
    } else if (middleware.name === 'router' && middleware.handle.stack) {
      let routerPath = basePath;
      if (middleware.regexp && middleware.regexp.source) {
        const match = middleware.regexp.source
          .replace('\\^\\/', '')
          .replace('\\/?(?=\\//|$)', '')
          .replace(/\\\//g, '/')
          .replace(/\^|\$/g, '');
        if (match && match !== '/') routerPath += '/' + match;
      }
      for (const handler of middleware.handle.stack) {
        processMiddleware(handler, routerPath);
      }
    }
  }

  if (app._router && app._router.stack) {
    for (const middleware of app._router.stack) {
      processMiddleware(middleware);
    }
  }
  return routes;
}

export function checkRouteParity(spec = swaggerSpec, expressApp = app) {
  const routes = extractExpressRoutes(expressApp);
  const specPaths = Object.keys(spec.paths || {});
  
  const undocumented = [];
  const specOrphans = [];

  for (const r of routes) {
    const normalized = r.path.replace(/:([a-zA-Z0-9_]+)/g, '{$1}');
    if (!specPaths.some((sp) => sp.toLowerCase() === normalized.toLowerCase())) {
      undocumented.push(`${r.method.toUpperCase()} ${r.path}`);
    }
  }

  for (const sp of specPaths) {
    const normalized = sp.replace(/\{([a-zA-Z0-9_]+)\}/g, ':$1');
    if (!routes.some((r) => r.path.toLowerCase() === normalized.toLowerCase())) {
      specOrphans.push(sp);
    }
  }

  return {
    valid: undocumented.length === 0 && specOrphans.length === 0,
    undocumented,
    specOrphans,
  };
}

if (process.argv[1]?.endsWith('check-openapi-route-parity.mjs')) {
  console.log('Running OpenAPI route parity check...');
  const result = checkRouteParity();
  if (!result.valid) {
    console.error('Route parity drift detected:');
    if (result.undocumented.length) {
      console.error('Undocumented Express routes:', result.undocumented);
    }
    if (result.specOrphans.length) {
      console.error('Spec orphans (documented but no route):', result.specOrphans);
    }
    process.exit(1);
  }
  console.log('OpenAPI route parity check passed!');
}
