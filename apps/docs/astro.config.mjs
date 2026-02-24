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
          ],
        },
        {
          label: 'Core',
          items: [
            { label: 'Core Concepts', link: '/core-concepts/' },
          ],
        },
      ],
    }),
  ],
});
