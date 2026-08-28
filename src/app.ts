private async setupDashboard(): Promise<void> {
  if (!this.bundler) {
    throw new Error('Bundler must be created before dashboard');
  }
  
  log.info('Starting dashboard...');
  
  try {
    if (this.config.dashboardType === 'full') {
      // Try full dashboard, fallback to simple if it fails
      try {
        this.dashboard = new Dashboard({
          refreshInterval: this.config.refreshInterval,
          showPriceChart: true,
          showVolumeChart: true,
        });
        this.dashboard.start(this.bundler);
        log.success('Full dashboard started');
      } catch (error) {
        log.warn('Full dashboard failed, falling back to simple dashboard');
        this.dashboard = new SimpleDashboard({
          refreshInterval: this.config.refreshInterval,
        });
        this.dashboard.start(this.bundler);
        log.success('Simple dashboard started');
      }
    } else {
      this.dashboard = new SimpleDashboard({
        refreshInterval: this.config.refreshInterval,
      });
      this.dashboard.start(this.bundler);
      log.success('Simple dashboard started');
    }
  } catch (error) {
    log.warn('Dashboard failed to start, continuing without it');
    this.dashboard = null;
  }
  
  await sleep(500);
}