/**
 * Cloudflare Pages Function - Music News Feed API
 * Endpoint: GET /api/news
 * 
 * Aggregates fresh music headlines from NME and Rolling Stone.
 * Parses titles, links, high-res images, categories, publication dates, and clean snippets.
 * Edge cached with 15-minute TTL.
 */

const CACHE_TTL_SECONDS = 900; // 15 minutes edge cache

function isAllowedOrigin(origin) {
  if (!origin) return false;
  try {
    const url = new URL(origin);
    const host = url.hostname;
    return (
      host === 'localhost' ||
      host === '127.0.0.1' ||
      host === 'lyricwave.pages.dev' ||
      host.endsWith('.lyricwave.pages.dev')
    );
  } catch {
    return false;
  }
}

function getCorsHeaders(request) {
  const origin = request.headers.get('Origin');
  const allowed = isAllowedOrigin(origin) ? origin : '*';

  return {
    'Access-Control-Allow-Origin': allowed,
    'Access-Control-Allow-Methods': 'GET, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Cache-Control': `public, max-age=${CACHE_TTL_SECONDS}, s-maxage=${CACHE_TTL_SECONDS}`,
    'Vary': 'Origin'
  };
}

function cleanCdata(text) {
  if (!text) return '';
  return text
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1')
    .replace(/<[^>]+>/g, '') // strip HTML tags
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#038;/g, '&')
    .replace(/&#8216;|&#8217;/g, "'")
    .replace(/&#8220;|&#8221;/g, '"')
    .replace(/&#8230;/g, '...')
    .trim();
}

function parseRssXml(xml, sourceName) {
  const items = [];
  const itemMatches = xml.match(/<item[\s\S]*?<\/item>/gi) || [];

  for (const itemXml of itemMatches) {
    try {
      // 1. Title
      const titleMatch = itemXml.match(/<title>([\s\S]*?)<\/title>/i);
      const title = cleanCdata(titleMatch?.[1] || '');
      if (!title) continue;

      // 2. Link
      const linkMatch = itemXml.match(/<link>([\s\S]*?)<\/link>/i);
      const link = (linkMatch?.[1] || '').trim();

      // 3. PubDate
      const pubDateMatch = itemXml.match(/<pubDate>([\s\S]*?)<\/pubDate>/i);
      const pubDate = pubDateMatch?.[1] || '';

      // 4. Description / Excerpt
      const descMatch = itemXml.match(/<description>([\s\S]*?)<\/description>/i);
      let excerpt = cleanCdata(descMatch?.[1] || '');
      if (excerpt.length > 220) {
        excerpt = excerpt.slice(0, 217).trim() + '...';
      }

      // 5. Image Extraction (content:encoded, enclosure, media:content, or <img>)
      let imageUrl = '';
      const encodedMatch = itemXml.match(/<content:encoded>([\s\S]*?)<\/content:encoded>/i);
      const encodedContent = encodedMatch?.[1] || '';
      
      const imgInEncoded = encodedContent.match(/<img[^>]+src=["']([^"']+)["']/i);
      if (imgInEncoded?.[1]) {
        imageUrl = imgInEncoded[1];
      } else {
        const encMatch = itemXml.match(/<enclosure[^>]+url=["']([^"']+)["']/i);
        if (encMatch?.[1]) {
          imageUrl = encMatch[1];
        } else {
          const mediaMatch = itemXml.match(/<media:content[^>]+url=["']([^"']+)["']/i);
          if (mediaMatch?.[1]) imageUrl = mediaMatch[1];
        }
      }

      // 6. Category / Tag
      const catMatch = itemXml.match(/<category>([\s\S]*?)<\/category>/i);
      const category = cleanCdata(catMatch?.[1] || 'Music');

      items.push({
        id: `news_${sourceName.toLowerCase()}_${Date.now()}_${items.length}`,
        title,
        link,
        pubDate,
        excerpt,
        imageUrl: imageUrl || '',
        category: category || 'Trending',
        source: sourceName
      });
    } catch {
      // skip malformed item
    }
  }

  return items;
}

export async function onRequestOptions({ request }) {
  return new Response(null, {
    status: 204,
    headers: getCorsHeaders(request)
  });
}

export async function onRequestGet({ request }) {
  const corsHeaders = getCorsHeaders(request);
  const url = new URL(request.url);
  const limit = Math.min(30, Math.max(5, parseInt(url.searchParams.get('limit') || '15', 10)));
  const categoryFilter = (url.searchParams.get('category') || 'all').toLowerCase();

  try {
    const fetchHeaders = {
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
      'Accept': 'application/rss+xml, application/xml, text/xml, */*'
    };

    const [nmeRes, rsRes] = await Promise.allSettled([
      fetch('https://www.nme.com/feed/', { headers: fetchHeaders }),
      fetch('https://www.rollingstone.com/music/feed/', { headers: fetchHeaders })
    ]);

    let articles = [];

    if (nmeRes.status === 'fulfilled' && nmeRes.value.ok) {
      const xml = await nmeRes.value.text();
      articles.push(...parseRssXml(xml, 'NME'));
    }

    if (rsRes.status === 'fulfilled' && rsRes.value.ok) {
      const xml = await rsRes.value.text();
      articles.push(...parseRssXml(xml, 'Rolling Stone'));
    }

    // Interleave and sort by date descending if valid
    articles.sort((a, b) => {
      const dateA = new Date(a.pubDate).getTime() || 0;
      const dateB = new Date(b.pubDate).getTime() || 0;
      return dateB - dateA;
    });

    if (categoryFilter !== 'all') {
      articles = articles.filter(a => a.category.toLowerCase().includes(categoryFilter));
    }

    const trimmed = articles.slice(0, limit);

    return new Response(JSON.stringify({
      success: true,
      count: trimmed.length,
      updated: new Date().toISOString(),
      articles: trimmed
    }), {
      status: 200,
      headers: {
        'Content-Type': 'application/json',
        ...corsHeaders
      }
    });

  } catch (err) {
    return new Response(JSON.stringify({
      success: false,
      error: err.message,
      articles: []
    }), {
      status: 502,
      headers: {
        'Content-Type': 'application/json',
        ...corsHeaders
      }
    });
  }
}
