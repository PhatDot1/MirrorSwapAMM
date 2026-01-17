// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import {IL1Read} from "./interfaces/IL1Read.sol";

contract MockL1Read is IL1Read {
    uint64 public price;
    uint64 public conf;

    function set(uint64 _price, uint64 _conf) external {
        price = _price;
        conf = _conf;
    }

    function perpOraclePrice(uint32) external view returns (uint64, uint64) {
        return (price, conf);
    }
}
