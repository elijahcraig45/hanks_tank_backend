// Main application file
import express from 'express';
import cors from 'cors';
import { config } from './config/app';
import { logger, logStartup } from './utils/logger';
import hybridTeamsRoutes from './routes/hybrid-teams.routes';
import legacyRoutes from './routes/legacy.routes';
import { validateGCPConfig } from './config/gcp.config';
import { schedulerService } from './services/scheduler.service';

const app = express();

// Middleware
app.use(cors(config.cors));
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// Request logging middleware
app.use((req, res, next) => {
  const startTime = Date.now();
  
  res.on('finish', () => {
    const responseTime = Date.now() - startTime;
    logger.info('HTTP Request', {
      method: req.method,
      url: req.url,
      statusCode: res.statusCode,
      responseTime,
      userAgent: req.get('User-Agent'),
      ip: req.ip
    });
  });
  
  next();
});

// Health check endpoint
app.get('/health', (req, res) => {
  const gcpValidation = validateGCPConfig();
  
  res.json({
    status: 'healthy',
    timestamp: new Date().toISOString(),
    version: '2.0.0',
    service: 'hanks-tank-backend',
    gcp: {
      configured: gcpValidation.isValid,
      errors: gcpValidation.isValid ? undefined : gcpValidation.errors
    }
  });
});

// API Routes
app.use('/api/v2/teams', hybridTeamsRoutes); // Hybrid routes with intelligent data sourcing
app.use('/api', legacyRoutes); // Legacy endpoints for backward compatibility

// 404 handler
app.use('*', (req, res) => {
  res.status(404).json({
    success: false,
    error: {
      code: 'NOT_FOUND',
      message: `Route ${req.method} ${req.originalUrl} not found`
    }
  });
});

// Error handler
app.use((error: any, req: express.Request, res: express.Response, next: express.NextFunction) => {
  logger.error('Unhandled error', {
    error: error.message,
    stack: error.stack,
    url: req.url,
    method: req.method
  });
  
  res.status(500).json({
    success: false,
    error: {
      code: 'INTERNAL_SERVER_ERROR',
      message: 'An unexpected error occurred'
    }
  });
});

// Start server
const PORT = config.port;
const server = app.listen(PORT, () => {
  logStartup();
  logger.info(`Server started on port ${PORT}`, {
    environment: config.nodeEnv,
    port: PORT
  });
  
  // Initialize scheduler for news fetching
  logger.info('Initializing scheduled tasks...');
  // Note: schedulerService is already initialized when imported
  logger.info('Scheduler service initialized successfully');
});

// Graceful shutdown handling
let isShuttingDown = false;

const gracefulShutdown = async (signal: string) => {
  if (isShuttingDown) {
    logger.warn('Forced shutdown - terminating immediately');
    process.exit(1);
  }
  
  isShuttingDown = true;
  logger.info(`${signal} received, starting graceful shutdown...`);

  // Stop accepting new connections
  server.close((err) => {
    if (err) {
      logger.error('Error closing server', { error: err.message });
      process.exit(1);
    }
    
    // Stop scheduler jobs
    try {
      schedulerService.stopAllJobs();
      logger.info('Scheduler jobs stopped');
    } catch (error) {
      logger.error('Error stopping scheduler jobs', { 
        error: error instanceof Error ? error.message : 'Unknown error' 
      });
    }
    
    logger.info('Server closed successfully');
    process.exit(0);
  });

  // Force shutdown after 10 seconds
  setTimeout(() => {
    logger.error('Forced shutdown after timeout');
    process.exit(1);
  }, 10000);
};

// Handle different shutdown signals
process.on('SIGINT', () => gracefulShutdown('SIGINT'));
process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));
process.on('SIGUSR2', () => gracefulShutdown('SIGUSR2')); // nodemon restart

// Handle uncaught exceptions
process.on('uncaughtException', (error) => {
  logger.error('Uncaught Exception', { 
    error: error.message, 
    stack: error.stack 
  });
  process.exit(1);
});

process.on('unhandledRejection', (reason, promise) => {
  logger.error('Unhandled Rejection', { 
    reason: reason instanceof Error ? reason.message : reason,
    promise: promise
  });
  process.exit(1);
});

export default app;
