import * as winston from 'winston';
import { config } from '../config/app';

// Custom log format
const logFormat = winston.format.combine(
  winston.format.timestamp({
    format: 'YYYY-MM-DD HH:mm:ss'
  }),
  winston.format.errors({ stack: true }),
  winston.format.colorize({ all: true }),
  winston.format.printf((info) => {
    const { timestamp, level, message, stack, ...meta } = info;
    
    // If there's a stack trace, include it
    if (stack) {
      return `${timestamp} [${level}]: ${message}\n${stack}`;
    }
    
    // If there's additional metadata, include it
    if (Object.keys(meta).length > 0) {
      return `${timestamp} [${level}]: ${message} ${JSON.stringify(meta, null, 2)}`;
    }
    
    return `${timestamp} [${level}]: ${message}`;
  })
);

// File format (without colors)
const fileFormat = winston.format.combine(
  winston.format.timestamp({
    format: 'YYYY-MM-DD HH:mm:ss'
  }),
  winston.format.errors({ stack: true }),
  winston.format.printf((info) => {
    const { timestamp, level, message, stack, ...meta } = info;
    
    if (stack) {
      return `${timestamp} [${level}]: ${message}\n${stack}`;
    }
    
    if (Object.keys(meta).length > 0) {
      return `${timestamp} [${level}]: ${message} ${JSON.stringify(meta)}`;
    }
    
    return `${timestamp} [${level}]: ${message}`;
  })
);

// Create logger
const transports: winston.transport[] = [];

// In production (App Engine), only use console logging (file system is read-only)
// In development, use both file and console logging
if (config.nodeEnv !== 'production') {
  transports.push(
    // Error log file
    new winston.transports.File({
      filename: `./logs/error.log`,
      level: 'error',
      maxsize: 10485760, // 10MB
      maxFiles: 5,
    }),
    
    // Combined log file
    new winston.transports.File({
      filename: `./logs/combined.log`,
      maxsize: 10485760, // 10MB
      maxFiles: 10,
    }),
    
    // Performance log file for API metrics
    new winston.transports.File({
      filename: `./logs/performance.log`,
      level: 'info',
      maxsize: 10485760, // 10MB
      maxFiles: 5,
      format: winston.format.combine(
        winston.format.timestamp(),
        winston.format.json()
      )
    })
  );
}

// Add console transport
if (config.nodeEnv !== 'production') {
  transports.push(new winston.transports.Console({
    format: logFormat
  }));
} else {
  // Production: use console with JSON format for Google Cloud Logging
  transports.push(new winston.transports.Console({
    level: config.logging.level,
    format: winston.format.combine(
      winston.format.timestamp(),
      winston.format.json()
    )
  }));
}

export const logger = winston.createLogger({
  level: config.logging.level,
  format: fileFormat,
  defaultMeta: { service: 'hanks-tank-backend' },
  transports
});

// MLB API specific logger
export const mlbApiLogger = logger.child({ component: 'mlb-api' });

// Cache specific logger
export const cacheLogger = logger.child({ component: 'cache' });

// Analytics specific logger
export const analyticsLogger = logger.child({ component: 'analytics' });

// Performance logger for tracking API response times
export const performanceLogger = {
  logApiCall: (
    method: string,
    endpoint: string,
    duration: number,
    statusCode: number,
    cacheHit: boolean = false,
    userId?: string
  ) => {
    logger.info('API_CALL', {
      method,
      endpoint,
      duration,
      statusCode,
      cacheHit,
      userId,
      timestamp: new Date().toISOString()
    });
  },

  logMLBApiCall: (
    endpoint: string,
    duration: number,
    statusCode: number,
    retryCount: number = 0
  ) => {
    mlbApiLogger.info('MLB_API_CALL', {
      endpoint,
      duration,
      statusCode,
      retryCount,
      timestamp: new Date().toISOString()
    });
  },

  logCacheOperation: (
    operation: 'get' | 'set' | 'del',
    key: string,
    hit?: boolean,
    ttl?: number
  ) => {
    cacheLogger.debug('CACHE_OPERATION', {
      operation,
      key,
      hit,
      ttl,
      timestamp: new Date().toISOString()
    });
  },

  logAnalyticsCalculation: (
    calculationType: string,
    duration: number,
    inputSize: number,
    outputSize: number
  ) => {
    analyticsLogger.info('ANALYTICS_CALCULATION', {
      calculationType,
      duration,
      inputSize,
      outputSize,
      timestamp: new Date().toISOString()
    });
  }
};

// Error types for structured logging
export enum ErrorTypes {
  MLB_API_ERROR = 'MLB_API_ERROR',
  CACHE_ERROR = 'CACHE_ERROR',
  DATABASE_ERROR = 'DATABASE_ERROR',
  VALIDATION_ERROR = 'VALIDATION_ERROR',
  AUTHENTICATION_ERROR = 'AUTHENTICATION_ERROR',
  RATE_LIMIT_ERROR = 'RATE_LIMIT_ERROR',
  EXTERNAL_SERVICE_ERROR = 'EXTERNAL_SERVICE_ERROR',
  UNKNOWN_ERROR = 'UNKNOWN_ERROR'
}

// Structured error logging
export const logError = (
  error: Error,
  context: {
    type: ErrorTypes;
    endpoint?: string;
    userId?: string;
    requestId?: string;
    additionalInfo?: any;
  }
) => {
  logger.error('STRUCTURED_ERROR', {
    errorType: context.type,
    message: error.message,
    stack: error.stack,
    endpoint: context.endpoint,
    userId: context.userId,
    requestId: context.requestId,
    additionalInfo: context.additionalInfo,
    timestamp: new Date().toISOString()
  });
};

// Request logging middleware helper
export const createRequestLogger = () => {
  return (req: any, res: any, next: any) => {
    const startTime = Date.now();
    const requestId = Math.random().toString(36).substring(7);
    
    // Add request ID to request object for tracking
    req.requestId = requestId;
    
    logger.info('REQUEST_START', {
      requestId,
      method: req.method,
      url: req.url,
      userAgent: req.get('User-Agent'),
      ip: req.ip,
      timestamp: new Date().toISOString()
    });

    // Override res.end to log response
    const originalEnd = res.end;
    res.end = function(...args: any[]) {
      const duration = Date.now() - startTime;
      
      logger.info('REQUEST_END', {
        requestId,
        method: req.method,
        url: req.url,
        statusCode: res.statusCode,
        duration,
        timestamp: new Date().toISOString()
      });
      
      // Log to performance logger as well
      performanceLogger.logApiCall(
        req.method,
        req.url,
        duration,
        res.statusCode,
        res.get('X-Cache-Status') === 'HIT'
      );
      
      originalEnd.apply(this, args);
    };

    next();
  };
};

// Log startup information
export const logStartup = () => {
  logger.info('APPLICATION_STARTUP', {
    nodeVersion: process.version,
    environment: config.nodeEnv,
    port: config.port,
    logLevel: config.logging.level,
    timestamp: new Date().toISOString()
  });
};

// Log shutdown information
export const logShutdown = (signal: string) => {
  logger.info('APPLICATION_SHUTDOWN', {
    signal,
    uptime: process.uptime(),
    timestamp: new Date().toISOString()
  });
};

// Export default logger
export default logger;
