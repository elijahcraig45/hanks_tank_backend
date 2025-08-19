// Simple rate limiting middleware - placeholder for now
import { Request, Response, NextFunction } from 'express';

export const rateLimitMiddleware = (req: Request, res: Response, next: NextFunction): void => {
  // Rate limiting implementation will be added later
  next();
};
