private async launchToken(): Promise<void> {
  logger.section('STEP 2: LAUNCHING TOKEN');
  this.status.phase = 'launching';

  const mainWallet = this.walletManager.getMainWallet();
  if (!mainWallet) {
    throw new Error('Main wallet not found');
  }

  // Create token
  const result = await this.tokenFactory.createToken({
    name: this.config.tokenName,
    symbol: this.config.tokenSymbol,
    decimals: 9,
    supply: this.config.tokenSupply,
    initialLiquidity: this.config.initialLiquidity,
    creatorWallet: mainWallet,
  });

  if (!result.success || !result.mintAddress) {
    // Try again with simpler name if it failed
    logger.warn('Token creation failed, retrying with simpler name...');
    const retryResult = await this.tokenFactory.createToken({
      name: 'TEST' + Date.now().toString().slice(-4),
      symbol: 'TST',
      decimals: 9,
      supply: 100_000_000,
      initialLiquidity: 0.5,
      creatorWallet: mainWallet,
    });
    
    if (!retryResult.success || !retryResult.mintAddress) {
      throw new Error(`Token creation failed: ${retryResult.error}`);
    }
    
    this.tokenMint = new PublicKey(retryResult.mintAddress);
    this.tokenDecimals = retryResult.decimals || 9;
    this.status.tokenMint = retryResult.mintAddress;
    this.status.tokenName = retryResult.name;
    this.status.tokenSymbol = retryResult.symbol;
  } else {
    this.tokenMint = new PublicKey(result.mintAddress);
    this.tokenDecimals = result.decimals || 9;
    this.status.tokenMint = result.mintAddress;
    this.status.tokenName = result.name;
    this.status.tokenSymbol = result.symbol;
  }

  logger.success('Token launched', {
    name: this.status.tokenName,
    symbol: this.status.tokenSymbol,
    mint: shortAddress(this.status.tokenMint),
  });

  await sleep(5000);

  const price = await this.jupiter.getTokenPrice(this.tokenMint);
  this.status.currentPrice = price || 0.000001;
  this.status.currentMultiplier = 1;

  logger.info('Initial price', {
    price: formatPrice(this.status.currentPrice),
  });
}