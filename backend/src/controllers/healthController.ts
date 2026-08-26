import type { Request, Response } from 'express';
import { query } from '../db/connection.js';
import { isCurrentlyFailingOver, getFailoverEvents } from '../services/failoverAlertService.js';
import logger from '../utils/logger.js';

export async function getHealth(req: Request, res: Response): Promise<void> {
  try {
    const result = await query('SELECT 1 as health');

    res.status(200).json({
      success: true,
      status: 'healthy',
      timestamp: new Date().toISOString(),
      database: {
        status: 'connected',
        failoverActive: isCurrentlyFailingOver(),
      },
    });
  } catch (error) {
    logger.error('Health check failed', { error });

    res.status(503).json({
      success: false,
      status: 'unhealthy',
      timestamp: new Date().toISOString(),
      database: {
        status: 'disconnected',
        failoverActive: isCurrentlyFailingOver(),
      },
      error: error instanceof Error ? error.message : 'Unknown error',
    });
  }
}

export async function getConnectionStatus(req: Request, res: Response): Promise<void> {
  try {
    const startTime = Date.now();
    await query('SELECT 1');
    const latency = Date.now() - startTime;

    res.status(200).json({
      success: true,
      connection: {
        status: 'connected',
        latency: `${latency}ms`,
        failoverActive: isCurrentlyFailingOver(),
        recentEvents: getFailoverEvents(10),
      },
      timestamp: new Date().toISOString(),
    });
  } catch (error) {
    res.status(503).json({
      success: false,
      connection: {
        status: 'disconnected',
        failoverActive: isCurrentlyFailingOver(),
        recentEvents: getFailoverEvents(10),
      },
      error: error instanceof Error ? error.message : 'Unknown error',
      timestamp: new Date().toISOString(),
    });
  }
}
