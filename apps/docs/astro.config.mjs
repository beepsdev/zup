import { defineConfig } from 'astro/config';
import starlight from '@astrojs/starlight';

const site = process.env.DOCS_SITE_URL;

export default defineConfig({
  site: site || undefined,
  base: '/docs',
  integrations: [
    starlight({
      title: 'Zup Docs',
      description: 'Open source AI SRE agent framework documentation.',
      sidebar: [
        {
          label: 'Getting Started',
          items: [
            { label: 'Overview', link: '/' },
            { label: 'Quickstart', link: '/getting-started/' },
            { label: 'Running the Examples', link: '/examples/' },
          ],
        },
        {
          label: 'Core',
          items: [
            { label: 'Core Concepts', link: '/core-concepts/' },
            { label: 'Agent Configuration', link: '/agent-config/' },
            { label: 'The OODA Loop', link: '/ooda-loop/' },
            { label: 'State & Persistence', link: '/state/' },
            { label: 'Approval Queue', link: '/approvals/' },
          ],
        },
        {
          label: 'Plugins',
          items: [
            { label: 'Plugin Overview', link: '/plugins/' },
            { label: 'Writing a Plugin', link: '/plugins/authoring/' },
            { label: 'http-monitor', link: '/plugins/http-monitor/' },
            { label: 'historian', link: '/plugins/historian/' },
            { label: 'investigation-orienter', link: '/plugins/investigation-orienter/' },
            { label: 'kubernetes', link: '/plugins/kubernetes/' },
            { label: 'cloud-run', link: '/plugins/cloud-run/' },
            { label: 'fly-machines', link: '/plugins/fly-machines/' },
            { label: 'vercel-deploys', link: '/plugins/vercel-deploys/' },
            { label: 'github-activity', link: '/plugins/github-activity/' },
          ],
        },
        {
          label: 'Integrations',
          items: [
            { label: 'LLM Providers', link: '/integrations/llm/' },
            { label: 'SQLite & Embeddings', link: '/integrations/sqlite/' },
          ],
        },
        {
          label: 'API Reference',
          items: [
            { label: 'REST API', link: '/api/' },
            { label: 'TypeScript API', link: '/api/typescript/' },
          ],
        },
      ],
    }),
  ],
});
