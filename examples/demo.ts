import { createAgent } from '../packages/core/src/index';
import { examplePlugin } from '../packages/plugins/example';

async function main() {
  console.log('=== Zup Demo ===\n');

  const agent = await createAgent({
    name: 'Demo Agent',
    mode: 'manual',
    plugins: [
      examplePlugin({
        serviceName: 'my-api-service',
      }),
    ],
  });

  console.log('Agent created successfully!\n');

  const capabilities = agent.getCapabilities();
  console.log('Available capabilities:');
  console.log('- Observers:', capabilities.observers);
  console.log('- Orienters:', capabilities.orienters);
  console.log('- Decision Strategies:', capabilities.decisionStrategies);
  console.log('- Actions:', capabilities.actions);
  console.log();

  console.log('Running OODA loop...\n');
  const result = await agent.runLoop();

  // Display results
  console.log('\n=== OODA Loop Results ===\n');

  console.log('OBSERVE Phase:');
  console.log(`- Collected ${result.observations.length} observations`);
  result.observations.forEach(obs => {
    console.log(`  - [${obs.severity}] ${obs.source}: ${JSON.stringify(obs.data)}`);
  });

  console.log('\nORIENT Phase:');
  if (result.situation) {
    console.log(`- Summary: ${result.situation.summary}`);
    console.log(`- Priority: ${result.situation.priority}`);
    console.log(`- Confidence: ${result.situation.confidence}`);
    result.situation.assessments.forEach(assessment => {
      console.log(`  - ${assessment.source}:`);
      assessment.findings.forEach(finding => {
        console.log(`    - ${finding}`);
      });
    });
  }

  console.log('\nDECIDE Phase:');
  if (result.decision) {
    console.log(`- Action: ${result.decision.action}`);
    console.log(`- Rationale: ${result.decision.rationale}`);
    console.log(`- Confidence: ${result.decision.confidence}`);
    console.log(`- Risk: ${result.decision.risk}`);
  }

  console.log('\nACT Phase:');
  console.log(`- Executed ${result.actionResults.length} actions`);
  result.actionResults.forEach(actionResult => {
    console.log(`  - ${actionResult.action}: ${actionResult.success ? '✓' : '✗'}`);
    if (actionResult.output) {
      console.log(`    Output: ${actionResult.output}`);
    }
    if (actionResult.error) {
      console.log(`    Error: ${actionResult.error}`);
    }
  });

  console.log(`\n=== Loop completed in ${result.duration}ms ===\n`);

  const history = agent.getHistory();
  console.log(`Total loops executed: ${history.length}`);
}

main().catch(console.error);
