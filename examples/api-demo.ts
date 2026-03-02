import { createAgent } from '../packages/core/src/index';
import { examplePlugin } from 'zupdev/plugins/example';
import winston from 'winston';

async function main() {
  console.log('=== Zup API Demo ===\n');

  // Configure Winston logger
  const logger = winston.createLogger({
    level: 'info',
    format: winston.format.combine(
      winston.format.timestamp({ format: 'YYYY-MM-DD HH:mm:ss' }),
      winston.format.errors({ stack: true }),
      winston.format.colorize(),
      winston.format.printf(({ timestamp, level, message, ...meta }) => {
        const metaStr = Object.keys(meta).length ? JSON.stringify(meta, null, 2) : '';
        return `${timestamp} [${level}]: ${message} ${metaStr}`;
      })
    ),
    transports: [
      new winston.transports.Console(),
    ],
  });

  logger.info('Starting Zup with Winston logger');

  const agent = await createAgent({
    name: 'API Demo Agent',
    logger, // Pass Winston logger to Zup
    plugins: [
      examplePlugin({
        serviceName: 'my-api-service',
      }),
    ],
  });

  const server = agent.startApi({
    port: 3000,
    hostname: 'localhost',
    apiKeys: ['demo-key-123'], // Optional: add API key auth
  });

  console.log('\nAPI is running! Try these commands:\n');
  console.log('# Health check');
  console.log('curl http://localhost:3000/api/v0/health\n');

  console.log('# Get agent state');
  console.log('curl http://localhost:3000/api/v0/state \\\n  -H "Authorization: Bearer demo-key-123"\n');

  console.log('# Trigger OODA loop');
  console.log('curl -X POST http://localhost:3000/api/v0/loop/trigger \\\n  -H "Authorization: Bearer demo-key-123" \\\n  -H "Content-Type: application/json" \\\n  -d \'{"context": "Manual health check"}\'\n');

  console.log('# Get loop status');
  console.log('curl http://localhost:3000/api/v0/loop/status \\\n  -H "Authorization: Bearer demo-key-123"\n');

  console.log('# List available actions');
  console.log('curl http://localhost:3000/api/v0/actions \\\n  -H "Authorization: Bearer demo-key-123"\n');

  console.log('# Execute an action');
  console.log('curl -X POST http://localhost:3000/api/v0/actions/example:restartService \\\n  -H "Authorization: Bearer demo-key-123" \\\n  -H "Content-Type: application/json" \\\n  -d \'{"params": {"serviceName": "my-api-service"}}\'\n');

  console.log('Press Ctrl+C to stop the server');

  await new Promise(() => {});
}

main().catch(console.error);
