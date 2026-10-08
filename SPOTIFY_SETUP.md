# LyricWave: Spotify Dashboard Setup Checklist

Follow these steps to configure your Spotify Developer Application for LyricWave.

---

### Step 1: Open the Spotify Developer Dashboard
1. Go to [developer.spotify.com/dashboard](https://developer.spotify.com/dashboard) and log in with your Spotify account.

---

### Step 2: Create Your Application
1. Click **Create app** (top right).
2. Fill in:
   - **App name**: `LyricWave` (or any name you prefer)
   - **App description**: `Real-time synchronized lyrics companion`
   - **Redirect URIs**: Enter your local server URL:
     - `http://127.0.0.1:8080/`
     - *(Optional: Also add `http://localhost:8080/` or `http://localhost:3000/` if using alternate ports)*
     - `https://lyricwave.pages.dev/` (the live website)
     - `lyricwave://callback` (the Android app — login opens in a Chrome Custom Tab and returns here)
     > ⚠️ **Important**: Spotify requires the exact match, including the trailing slash `/` or exact file path.
   - **Which API/SDKs are you planning to use?**: Select **Web API**.
3. Accept the Spotify Developer Terms of Service and click **Save**.

---

### Step 3: Copy Your Client ID
1. In your new app's dashboard, click **Settings** (top right).
2. Look for **Basic Information** -> **Client ID**.
3. Click **Copy Client ID**.
   > 🔒 **Security Notice**: Do **NOT** copy or use the **Client Secret**. The PKCE Authorization Code flow runs entirely in your browser and never requires a Client Secret.

---

### Step 4: Update `config.js`
1. Open [`config.js`](file:///c:/Users/User/Documents/antigravity/serene-newton/config.js).
2. Replace `"YOUR_SPOTIFY_CLIENT_ID"` with your copied 32-character Client ID:
   ```javascript
   export const CONFIG = {
     CLIENT_ID: "your_copied_client_id_here",
     REDIRECT_URI: window.location.origin + window.location.pathname.replace(/\/index\.html$/, "/"),
     ...
   };
   ```

---

### Step 5: (If App is in Development Mode) Add Test Users
1. In the Spotify Dashboard, click **User Management**.
2. If your Spotify account email isn't already listed, click **Add User** and enter your Spotify account name and email address.

---

### Step 6: Run LyricWave Locally
Since LyricWave uses ES modules (`import`/`export`), open it through a local HTTP server (not `file://`):

```powershell
python -m http.server 8080
```
Then open:
👉 **[http://127.0.0.1:8080/](http://127.0.0.1:8080/)** in your browser.
