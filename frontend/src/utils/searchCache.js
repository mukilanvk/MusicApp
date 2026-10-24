// IndexedDB utility for caching YouTube search results to save API quota tokens

const DB_NAME = 'MusicAppDB';
const DB_VERSION = 1;
const STORE_NAME = 'search_cache';

const openDB = () => {
  return new Promise((resolve, reject) => {
    if (typeof window === 'undefined' || !window.indexedDB) {
      reject(new Error('IndexedDB is not supported in this environment'));
      return;
    }

    const request = window.indexedDB.open(DB_NAME, DB_VERSION);

    request.onerror = () => {
      reject(request.error);
    };

    request.onsuccess = () => {
      resolve(request.result);
    };

    request.onupgradeneeded = (event) => {
      const db = event.target.result;
      if (!db.objectStoreNames.contains(STORE_NAME)) {
        db.createObjectStore(STORE_NAME, { keyPath: 'query' });
      }
    };
  });
};

/**
 * Retrieve cached search results from IndexedDB (with localStorage fallback)
 * @param {string} query
 * @returns {Promise<Array|null>}
 */
export const getCachedSearch = async (query) => {
  const normalizedKey = (query || '').trim().toLowerCase();
  if (!normalizedKey) return null;

  try {
    const db = await openDB();
    return new Promise((resolve) => {
      const transaction = db.transaction(STORE_NAME, 'readonly');
      const store = transaction.objectStore(STORE_NAME);
      const request = store.get(normalizedKey);

      request.onsuccess = () => {
        if (request.result && Array.isArray(request.result.items) && request.result.items.length > 0) {
          resolve(request.result.items);
        } else {
          resolve(null);
        }
      };

      request.onerror = () => {
        resolve(null);
      };
    });
  } catch (err) {
    console.warn('IndexedDB read failed, checking localStorage fallback:', err);
    try {
      const local = localStorage.getItem(`search_cache_${normalizedKey}`);
      if (local) {
        return JSON.parse(local);
      }
    } catch {
      // ignore fallback error
    }
    return null;
  }
};

/**
 * Save search results to IndexedDB (with localStorage fallback)
 * @param {string} query
 * @param {Array} items
 * @returns {Promise<void>}
 */
export const setCachedSearch = async (query, items) => {
  const normalizedKey = (query || '').trim().toLowerCase();
  if (!normalizedKey || !items || !items.length) return;

  try {
    const db = await openDB();
    return new Promise((resolve) => {
      const transaction = db.transaction(STORE_NAME, 'readwrite');
      const store = transaction.objectStore(STORE_NAME);

      store.put({
        query: normalizedKey,
        originalQuery: query,
        items,
        timestamp: Date.now()
      });

      transaction.oncomplete = () => {
        resolve();
      };

      transaction.onerror = () => {
        resolve();
      };
    });
  } catch (err) {
    console.warn('IndexedDB write failed, falling back to localStorage:', err);
    try {
      localStorage.setItem(`search_cache_${normalizedKey}`, JSON.stringify(items));
    } catch {
      // ignore fallback error
    }
  }
};
