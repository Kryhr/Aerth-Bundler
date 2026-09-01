/**
 * AERTH BUNDLER - Pump.fun metadata upload
 *
 * Pump.fun's on-chain program only takes a `uri` string pointing at a JSON
 * metadata file - it has no idea about images or social links directly.
 * Getting that URI is pump.fun's own WEBSITE API, not part of their on-chain
 * program SDK (@pump-fun/pump-sdk only builds instructions). This is
 * confirmed by multiple independent third-party integration write-ups, not
 * pump.fun's own official docs repo (which only covers the on-chain
 * program) - verify with a real call before trusting it for a real launch.
 */
import { readFile } from 'fs/promises';
import path from 'path';
import { logger } from '../utils/logger';

export interface PumpFunMetadataParams {
  name: string;
  symbol: string;
  description?: string;
  iconPath?: string;
  twitter?: string;
  telegram?: string;
  website?: string;
}

export interface PumpFunMetadataResult {
  success: boolean;
  metadataUri?: string;
  error?: string;
}

const PUMPFUN_IPFS_ENDPOINT = 'https://pump.fun/api/ipfs';

export async function uploadPumpFunMetadata(params: PumpFunMetadataParams): Promise<PumpFunMetadataResult> {
  try {
    const form = new FormData();
    form.append('name', params.name);
    form.append('symbol', params.symbol);
    form.append('description', params.description || '');
    form.append('twitter', params.twitter || '');
    form.append('telegram', params.telegram || '');
    form.append('website', params.website || '');
    form.append('showName', 'true');

    if (params.iconPath) {
      const fileBuffer = await readFile(params.iconPath);
      const fileName = path.basename(params.iconPath);
      form.append('file', new Blob([fileBuffer]), fileName);
    }

    logger.info('Uploading token metadata to pump.fun...', {
      name: params.name,
      symbol: params.symbol,
      hasIcon: !!params.iconPath,
    });

    const response = await fetch(PUMPFUN_IPFS_ENDPOINT, {
      method: 'POST',
      body: form,
    });

    if (!response.ok) {
      const text = await response.text().catch(() => '');
      return { success: false, error: `pump.fun metadata upload failed: ${response.status} ${text.slice(0, 200)}` };
    }

    const data: any = await response.json();
    const metadataUri = data.metadataUri || data.metadata_uri || data.uri;

    if (!metadataUri) {
      return { success: false, error: `pump.fun metadata upload response had no URI: ${JSON.stringify(data).slice(0, 200)}` };
    }

    logger.success('Metadata uploaded', { metadataUri });
    return { success: true, metadataUri };

  } catch (error) {
    return { success: false, error: (error as Error).message };
  }
}
