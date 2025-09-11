// Telegram WebApp init
const tg = window.Telegram.WebApp;
tg.expand();

// Инициализация TON Connect UI
const tonConnectUI = new TON_CONNECT_UI.TonConnectUI({
  manifestUrl: "https://YOUR_DOMAIN/manifest.json" // 👈 Ссылка на твой манифест
});

const connectBtn = document.getElementById("connectBtn");
const walletInfo = document.getElementById("walletInfo");

connectBtn.addEventListener("click", async () => {
  try {
    const connectedWallet = await tonConnectUI.connectWallet();

    if (connectedWallet) {
      walletInfo.innerHTML = `
        ✅ Connected to: <b>${connectedWallet.account.address}</b><br/>
        Wallet: ${connectedWallet.device.appName}
      `;

      // Можно передать данные в Телеграм
      tg.sendData(JSON.stringify({
        action: "wallet_connected",
        address: connectedWallet.account.address
      }));
    }
  } catch (e) {
    console.error("Wallet connect error:", e);
    walletInfo.innerHTML = "❌ Connection failed";
  }
}); 
