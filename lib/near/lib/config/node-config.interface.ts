import * as configTypes from "../../../constructs/config.interface";

export type NearNetwork = "mainnet" | "testnet" | "betanet";

export interface NearDataVolumeConfig extends configTypes.DataVolumeConfig {}

export interface NearBaseConfig extends configTypes.BaseConfig {
    nearNetwork: NearNetwork;
    nearVersion: string;
}

export interface NearBaseNodeConfig extends configTypes.BaseNodeConfig {
    nearNetwork: NearNetwork;
    nearVersion: string;
    dataVolume: NearDataVolumeConfig;
    limitOutTrafficMbps: number;
}

export interface NearHAConfig {
    albHealthCheckGracePeriodMin: number;
    heartBeatDelayMin: number;
    numberOfNodes: number;
} 