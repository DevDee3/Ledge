// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";
import {LedgeRegistry} from "../src/LedgeRegistry.sol";

/// @dev Mimics the Base oracle adapter call shape: input abi.encode(uint32), output uint64 as a word.
contract MockOracle {
    mapping(uint32 => uint64) public px;
    bool public broken;
    bool public badLength;

    function set(uint32 index, uint64 value) external {
        px[index] = value;
    }

    function setBroken(bool b) external {
        broken = b;
    }

    function setBadLength(bool b) external {
        badLength = b;
    }

    fallback(bytes calldata data) external returns (bytes memory) {
        if (broken) revert("down");
        uint32 index = abi.decode(data, (uint32));
        if (badLength) return abi.encodePacked(px[index]); // 8 bytes, not a full word
        return abi.encode(uint256(px[index]));
    }
}

/// @dev Returns a value wider than uint64 to exercise the range check.
contract WideOracle {
    fallback(bytes calldata) external returns (bytes memory) {
        return abi.encode(uint256(type(uint64).max) + 1);
    }
}

contract LedgeRegistryTest is Test {
    LedgeRegistry internal reg;
    MockOracle internal oracle;

    address internal alice = makeAddr("alice");
    address internal bob = makeAddr("bob");

    uint32 internal constant BTC = 0;
    uint64 internal constant ENTRY = 64_000e1; // arbitrary raw scale
    uint128 internal constant NOTIONAL = 10_000e6;
    uint128 internal constant CAP = 300e6;
    bytes32 internal constant LEGS = keccak256("legs");

    event Committed(
        uint256 indexed id,
        address indexed owner,
        uint32 assetIndex,
        bool isLong,
        uint64 entryPx,
        uint128 notional,
        uint128 lossCap,
        uint64 expiry,
        bytes32 legsHash
    );
    event Settled(
        uint256 indexed id,
        address indexed owner,
        uint64 settlePx,
        uint128 unhedgedLoss,
        bool triggered,
        uint128 lossAvoided
    );
    event Lapsed(uint256 indexed id, address indexed owner);

    function setUp() public {
        vm.warp(1_800_000_000);
        oracle = new MockOracle();
        oracle.set(BTC, ENTRY);
        reg = new LedgeRegistry(address(oracle));
    }

    // ------------------------------------------------------------ helpers

    function _commit(address who, bool isLong) internal returns (uint256 id, uint64 expiry) {
        expiry = uint64(block.timestamp + 1 days);
        vm.prank(who);
        id = reg.commit(BTC, isLong, NOTIONAL, CAP, expiry, LEGS);
    }

    // ------------------------------------------------------------ constructor

    function test_constructor_storesOracle() public view {
        assertEq(reg.oracle(), address(oracle));
    }

    function test_constructor_revertsOnZeroOracle() public {
        vm.expectRevert(LedgeRegistry.InvalidParams.selector);
        new LedgeRegistry(address(0));
    }

    // ------------------------------------------------------------ commit

    function test_commit_readsEntryFromOracleAndEmits() public {
        uint64 expiry = uint64(block.timestamp + 1 days);
        vm.expectEmit(true, true, false, true);
        emit Committed(1, alice, BTC, true, ENTRY, NOTIONAL, CAP, expiry, LEGS);
        vm.prank(alice);
        uint256 id = reg.commit(BTC, true, NOTIONAL, CAP, expiry, LEGS);

        assertEq(id, 1);
        assertEq(reg.planCount(), 1);
        LedgeRegistry.Plan memory p = reg.getPlan(id);
        assertEq(p.owner, alice);
        assertEq(p.entryPx, ENTRY);
        assertEq(p.settlePx, 0);
        assertEq(uint8(p.status), uint8(LedgeRegistry.Status.Open));
        assertEq(p.legsHash, LEGS);
        assertTrue(p.isLong);
    }

    function test_commit_incrementsIds() public {
        (uint256 a,) = _commit(alice, true);
        (uint256 b,) = _commit(bob, false);
        assertEq(a, 1);
        assertEq(b, 2);
        assertEq(reg.getPlan(b).owner, bob);
    }

    function test_commit_revertsOnZeroNotional() public {
        vm.expectRevert(LedgeRegistry.InvalidParams.selector);
        reg.commit(BTC, true, 0, 0, uint64(block.timestamp + 1 days), LEGS);
    }

    function test_commit_revertsWhenCapExceedsNotional() public {
        vm.expectRevert(LedgeRegistry.InvalidParams.selector);
        reg.commit(BTC, true, 100e6, 101e6, uint64(block.timestamp + 1 days), LEGS);
    }

    function test_commit_allowsCapEqualToNotional() public {
        reg.commit(BTC, true, 100e6, 100e6, uint64(block.timestamp + 1 days), LEGS);
        assertEq(reg.planCount(), 1);
    }

    function test_commit_revertsOnPastOrCurrentExpiry() public {
        vm.expectRevert(LedgeRegistry.InvalidParams.selector);
        reg.commit(BTC, true, NOTIONAL, CAP, uint64(block.timestamp), LEGS);
    }

    function test_commit_revertsOnExpiryBeyondMax() public {
        uint64 tooFar = uint64(block.timestamp + reg.MAX_DURATION() + 1);
        vm.expectRevert(LedgeRegistry.InvalidParams.selector);
        reg.commit(BTC, true, NOTIONAL, CAP, tooFar, LEGS);
    }

    function test_commit_allowsExpiryAtExactlyMax() public {
        reg.commit(BTC, true, NOTIONAL, CAP, uint64(block.timestamp + reg.MAX_DURATION()), LEGS);
        assertEq(reg.planCount(), 1);
    }

    function test_commit_revertsWhenOracleReturnsZero() public {
        vm.expectRevert(LedgeRegistry.OracleUnavailable.selector);
        reg.commit(7, true, NOTIONAL, CAP, uint64(block.timestamp + 1 days), LEGS); // index 7 unset => 0
    }

    function test_commit_revertsWhenOracleReverts() public {
        oracle.setBroken(true);
        vm.expectRevert(LedgeRegistry.OracleUnavailable.selector);
        reg.commit(BTC, true, NOTIONAL, CAP, uint64(block.timestamp + 1 days), LEGS);
    }

    function test_commit_revertsWhenOracleReturnIsNotAWord() public {
        oracle.setBadLength(true);
        vm.expectRevert(LedgeRegistry.OracleUnavailable.selector);
        reg.commit(BTC, true, NOTIONAL, CAP, uint64(block.timestamp + 1 days), LEGS);
    }

    function test_commit_revertsWhenOraclePriceExceedsUint64() public {
        LedgeRegistry wide = new LedgeRegistry(address(new WideOracle()));
        vm.expectRevert(LedgeRegistry.OracleUnavailable.selector);
        wide.commit(BTC, true, NOTIONAL, CAP, uint64(block.timestamp + 1 days), LEGS);
    }

    function test_commit_revertsWhenOracleIsNotAContract() public {
        // staticcall to an EOA succeeds with empty returndata, which must be rejected.
        LedgeRegistry eoa = new LedgeRegistry(makeAddr("not-a-contract"));
        vm.expectRevert(LedgeRegistry.OracleUnavailable.selector);
        eoa.commit(BTC, true, NOTIONAL, CAP, uint64(block.timestamp + 1 days), LEGS);
    }

    // ------------------------------------------------------------ settle: long

    function test_settle_long_triggered() public {
        (uint256 id, uint64 expiry) = _commit(alice, true);
        vm.warp(expiry);
        oracle.set(BTC, ENTRY - ENTRY / 10); // -10% => loss 1000 > cap 300

        vm.expectEmit(true, true, false, true);
        emit Settled(id, alice, ENTRY - ENTRY / 10, 1_000e6, true, 700e6);
        reg.settle(id);

        LedgeRegistry.Plan memory p = reg.getPlan(id);
        assertEq(uint8(p.status), uint8(LedgeRegistry.Status.Settled));
        assertEq(p.settlePx, ENTRY - ENTRY / 10);
        assertEq(p.unhedgedLoss, 1_000e6);

        LedgeRegistry.Record memory r = reg.recordOf(alice);
        assertEq(r.settled, 1);
        assertEq(r.triggered, 1);
        assertEq(r.lapsed, 0);
        assertEq(r.totalLossAvoided, 700e6);
    }

    function test_settle_long_notTriggeredWhenLossWithinCap() public {
        (uint256 id, uint64 expiry) = _commit(alice, true);
        vm.warp(expiry);
        oracle.set(BTC, ENTRY - ENTRY / 50); // -2% => loss 200 < cap 300
        reg.settle(id);

        LedgeRegistry.Record memory r = reg.recordOf(alice);
        assertEq(r.settled, 1);
        assertEq(r.triggered, 0);
        assertEq(r.totalLossAvoided, 0);
        assertEq(reg.getPlan(id).unhedgedLoss, 200e6);
    }

    function test_settle_long_lossExactlyAtCapIsNotTriggered() public {
        (uint256 id, uint64 expiry) = _commit(alice, true);
        vm.warp(expiry);
        oracle.set(BTC, ENTRY - (ENTRY * 3) / 100); // -3% => loss exactly 300 == cap
        reg.settle(id);
        assertEq(reg.getPlan(id).unhedgedLoss, 300e6);
        assertEq(reg.recordOf(alice).triggered, 0);
    }

    function test_settle_long_priceUpMeansNoLoss() public {
        (uint256 id, uint64 expiry) = _commit(alice, true);
        vm.warp(expiry);
        oracle.set(BTC, ENTRY + ENTRY / 10);
        reg.settle(id);
        assertEq(reg.getPlan(id).unhedgedLoss, 0);
        assertEq(reg.recordOf(alice).triggered, 0);
    }

    // ------------------------------------------------------------ settle: short

    function test_settle_short_triggered() public {
        (uint256 id, uint64 expiry) = _commit(alice, false);
        vm.warp(expiry);
        oracle.set(BTC, ENTRY + ENTRY / 10); // +10% against a short
        reg.settle(id);
        assertEq(reg.getPlan(id).unhedgedLoss, 1_000e6);
        LedgeRegistry.Record memory r = reg.recordOf(alice);
        assertEq(r.triggered, 1);
        assertEq(r.totalLossAvoided, 700e6);
    }

    function test_settle_short_priceDownMeansNoLoss() public {
        (uint256 id, uint64 expiry) = _commit(alice, false);
        vm.warp(expiry);
        oracle.set(BTC, ENTRY - ENTRY / 10);
        reg.settle(id);
        assertEq(reg.getPlan(id).unhedgedLoss, 0);
    }

    function test_settle_short_lossCanExceedNotionalWhenPriceMoreThanDoubles() public {
        (uint256 id, uint64 expiry) = _commit(alice, false);
        vm.warp(expiry);
        oracle.set(BTC, ENTRY * 3); // +200% => loss 2x notional
        reg.settle(id);
        assertEq(reg.getPlan(id).unhedgedLoss, 2 * NOTIONAL);
    }

    // ------------------------------------------------------------ settle: guards

    function test_settle_isPermissionless() public {
        (uint256 id, uint64 expiry) = _commit(alice, true);
        vm.warp(expiry);
        vm.prank(makeAddr("keeper"));
        reg.settle(id);
        assertEq(reg.recordOf(alice).settled, 1); // credited to the plan owner, not the caller
        assertEq(reg.recordOf(makeAddr("keeper")).settled, 0);
    }

    function test_settle_revertsBeforeExpiry() public {
        (uint256 id, uint64 expiry) = _commit(alice, true);
        vm.warp(expiry - 1);
        vm.expectRevert(LedgeRegistry.TooEarly.selector);
        reg.settle(id);
    }

    function test_settle_succeedsAtLastSecondOfWindow() public {
        (uint256 id, uint64 expiry) = _commit(alice, true);
        vm.warp(expiry + reg.SETTLE_WINDOW());
        reg.settle(id);
        assertEq(uint8(reg.getPlan(id).status), uint8(LedgeRegistry.Status.Settled));
    }

    function test_settle_revertsAfterWindow() public {
        (uint256 id, uint64 expiry) = _commit(alice, true);
        vm.warp(expiry + reg.SETTLE_WINDOW() + 1);
        vm.expectRevert(LedgeRegistry.WindowClosed.selector);
        reg.settle(id);
    }

    function test_settle_revertsOnUnknownPlan() public {
        vm.expectRevert(LedgeRegistry.UnknownPlan.selector);
        reg.settle(42);
    }

    function test_settle_cannotBeRepeated() public {
        (uint256 id, uint64 expiry) = _commit(alice, true);
        vm.warp(expiry);
        reg.settle(id);
        vm.expectRevert(LedgeRegistry.NotOpen.selector);
        reg.settle(id);
    }

    function test_settle_revertsWhenOracleDown() public {
        (uint256 id, uint64 expiry) = _commit(alice, true);
        vm.warp(expiry);
        oracle.setBroken(true);
        vm.expectRevert(LedgeRegistry.OracleUnavailable.selector);
        reg.settle(id);
    }

    function test_settle_revertsWhenOracleReturnsZero() public {
        (uint256 id, uint64 expiry) = _commit(alice, true);
        vm.warp(expiry);
        oracle.set(BTC, 0);
        vm.expectRevert(LedgeRegistry.OracleUnavailable.selector);
        reg.settle(id);
        assertEq(uint8(reg.getPlan(id).status), uint8(LedgeRegistry.Status.Open));
    }

    function test_settle_doesNotMutateWhenOracleReturnsMalformedData() public {
        (uint256 id, uint64 expiry) = _commit(alice, true);
        vm.warp(expiry);
        oracle.setBadLength(true);
        vm.expectRevert(LedgeRegistry.OracleUnavailable.selector);
        reg.settle(id);
        assertEq(uint8(reg.getPlan(id).status), uint8(LedgeRegistry.Status.Open));
    }

    // ------------------------------------------------------------ lapse

    function test_lapse_marksUnsettledPlanAfterWindow() public {
        (uint256 id, uint64 expiry) = _commit(alice, true);
        vm.warp(expiry + reg.SETTLE_WINDOW() + 1);
        vm.expectEmit(true, true, false, false);
        emit Lapsed(id, alice);
        reg.lapse(id);
        assertEq(uint8(reg.getPlan(id).status), uint8(LedgeRegistry.Status.Lapsed));
        LedgeRegistry.Record memory r = reg.recordOf(alice);
        assertEq(r.lapsed, 1);
        assertEq(r.settled, 0);
    }

    function test_lapse_revertsWhileWindowOpen() public {
        (uint256 id, uint64 expiry) = _commit(alice, true);
        vm.warp(expiry + reg.SETTLE_WINDOW());
        vm.expectRevert(LedgeRegistry.WindowStillOpen.selector);
        reg.lapse(id);
    }

    function test_lapse_revertsOnUnknownPlan() public {
        vm.expectRevert(LedgeRegistry.UnknownPlan.selector);
        reg.lapse(1);
    }

    function test_lapse_revertsOnSettledPlan() public {
        (uint256 id, uint64 expiry) = _commit(alice, true);
        vm.warp(expiry);
        reg.settle(id);
        vm.warp(expiry + reg.SETTLE_WINDOW() + 1);
        vm.expectRevert(LedgeRegistry.NotOpen.selector);
        reg.lapse(id);
    }

    function test_lapsedPlanCannotBeSettled() public {
        (uint256 id, uint64 expiry) = _commit(alice, true);
        vm.warp(expiry + reg.SETTLE_WINDOW() + 1);
        reg.lapse(id);
        vm.expectRevert(LedgeRegistry.NotOpen.selector);
        reg.settle(id);
    }

    // ------------------------------------------------------------ views & records

    function test_getPlan_revertsOnUnknownPlan() public {
        vm.expectRevert(LedgeRegistry.UnknownPlan.selector);
        reg.getPlan(1);
    }

    function test_record_accumulatesAcrossPlansAndIsPerOwner() public {
        // alice: one triggered, one not. bob: untouched.
        (uint256 a1, uint64 e1) = _commit(alice, true);
        (uint256 a2,) = _commit(alice, true);
        vm.warp(e1);
        oracle.set(BTC, ENTRY - ENTRY / 10);
        reg.settle(a1); // triggered, avoided 700
        oracle.set(BTC, ENTRY - ENTRY / 100); // -1%, loss 100, within cap
        reg.settle(a2);

        LedgeRegistry.Record memory r = reg.recordOf(alice);
        assertEq(r.settled, 2);
        assertEq(r.triggered, 1);
        assertEq(r.totalLossAvoided, 700e6);
        assertEq(reg.recordOf(bob).settled, 0);
    }

    function test_unhedgedLossFor_matchesSettlement() public view {
        assertEq(reg.unhedgedLossFor(true, NOTIONAL, ENTRY, ENTRY - ENTRY / 10), 1_000e6);
        assertEq(reg.unhedgedLossFor(false, NOTIONAL, ENTRY, ENTRY + ENTRY / 10), 1_000e6);
        assertEq(reg.unhedgedLossFor(true, NOTIONAL, ENTRY, ENTRY + 1), 0);
        assertEq(reg.unhedgedLossFor(false, NOTIONAL, ENTRY, ENTRY - 1), 0);
    }

    function test_unhedgedLossFor_saturatesAtUint128Max() public view {
        // Huge short notional with a huge adverse move would overflow uint128 without the clamp.
        uint128 big = type(uint128).max;
        assertEq(reg.unhedgedLossFor(false, big, 1, type(uint64).max), type(uint128).max);
    }

    // ------------------------------------------------------------ configured oracle adapter

    function test_works_withConfiguredOracleAdapter() public {
        LedgeRegistry prod = new LedgeRegistry(address(oracle));
        uint64 expiry = uint64(block.timestamp + 1 days);
        vm.prank(alice);
        uint256 id = prod.commit(BTC, true, NOTIONAL, CAP, expiry, LEGS);
        vm.warp(expiry);
        oracle.set(BTC, ENTRY - ENTRY / 10);
        prod.settle(id);
        assertEq(prod.getPlan(id).unhedgedLoss, 1_000e6);
    }

    // ------------------------------------------------------------ fuzz

    function testFuzz_lossMath(bool isLong, uint128 notional, uint64 entry, uint64 px) public view {
        entry = uint64(bound(entry, 1, type(uint64).max));
        uint128 loss = reg.unhedgedLossFor(isLong, notional, entry, px);

        if (isLong && px >= entry) assertEq(loss, 0);
        if (!isLong && px <= entry) assertEq(loss, 0);

        // A long can never lose more than its notional (price floors at zero... or the oracle value 0 => full loss).
        if (isLong) assertLe(loss, notional);
        // Loss is monotone in the adverse move for a fixed side.
        if (isLong && px > 0) {
            uint128 lossAtLowerPx = reg.unhedgedLossFor(true, notional, entry, px - 1);
            assertGe(lossAtLowerPx, loss);
        }
    }

    function testFuzz_settleBookkeeping(bool isLong, uint128 notional, uint128 capSeed, uint64 movePx) public {
        notional = uint128(bound(notional, 1, 1e15));
        uint128 cap = uint128(bound(capSeed, 0, notional));
        movePx = uint64(bound(movePx, 1, type(uint64).max));

        uint64 expiry = uint64(block.timestamp + 1 days);
        vm.prank(alice);
        uint256 id = reg.commit(BTC, isLong, notional, cap, expiry, LEGS);

        vm.warp(expiry);
        oracle.set(BTC, movePx);
        reg.settle(id);

        LedgeRegistry.Plan memory p = reg.getPlan(id);
        LedgeRegistry.Record memory r = reg.recordOf(alice);

        uint128 expectedAvoided = p.unhedgedLoss > cap ? p.unhedgedLoss - cap : 0;
        assertEq(r.totalLossAvoided, expectedAvoided);
        assertEq(r.triggered, p.unhedgedLoss > cap ? 1 : 0);
        assertEq(r.settled, 1);
        assertEq(uint8(p.status), uint8(LedgeRegistry.Status.Settled));
        // The floor never claims to absorb more than the loss itself.
        assertLe(expectedAvoided, p.unhedgedLoss);
    }
}
