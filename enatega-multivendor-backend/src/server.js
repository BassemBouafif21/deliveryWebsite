import crypto from "node:crypto";
import http from "node:http";
import cors from "cors";
import express from "express";
import { WebSocket, WebSocketServer } from "ws";

const PORT = Number(process.env.PORT || 8001);
const PUBLIC_TOKEN_TTL_MS = 1000 * 60 * 30;
const USER_TOKEN_TTL_MS = 1000 * 60 * 60 * 24 * 30;
const RIDER_TICK_MS = 15000;
const ACTIVE_ORDER_STATUSES = new Set([
  "PENDING",
  "ACCEPTED",
  "ASSIGNED",
  "PICKED",
  "IN_TRANSIT",
]);

const state = createInitialState();
const wsSubscriptions = new Map();

const app = express();
app.use(cors({ origin: true, credentials: true }));
app.use(express.json({ limit: "2mb" }));

app.use((error, _req, res, next) => {
  if (error) {
    res.status(400).json({ errors: [{ message: "Invalid JSON payload" }] });
    return;
  }
  next();
});

app.get("/", (_req, res) => {
  res.json({
    name: "Enatega local backend",
    graphql: `http://localhost:${PORT}/graphql`,
    websocket: `ws://localhost:${PORT}/graphql`,
    demoUser: { email: "demo@enatega.local", password: "12345678" },
  });
});

app.get("/health", (_req, res) => {
  res.json({
    ok: true,
    now: nowIso(),
    users: state.users.length,
    restaurants: state.restaurants.length,
    orders: state.orders.length,
  });
});

app.post("/stripe/account", (_req, res) => {
  res.json({
    success: true,
    message: "Stripe account endpoint is mocked in local backend",
    url: "https://dashboard.stripe.com/",
  });
});

app.post("/graphql", (req, res) => {
  try {
    const parsed = parseGraphQLPayload(req.body);
    const currentUser = getCurrentUser(req.headers);
    const value = resolveField({
      rootField: parsed.rootField,
      variables: parsed.variables,
      currentUser,
      operationType: parsed.operationType,
    });

    res.json({
      data: {
        [parsed.responseKey]: value,
      },
    });
  } catch (error) {
    res.status(200).json({
      errors: [{ message: error instanceof Error ? error.message : "Unknown error" }],
    });
  }
});

const server = http.createServer(app);
const wss = new WebSocketServer({ server, path: "/graphql" });

wss.on("connection", (ws) => {
  wsSubscriptions.set(ws, new Map());

  ws.on("message", (raw) => {
    let message;
    try {
      message = JSON.parse(raw.toString());
    } catch (_error) {
      return;
    }

    const type = String(message?.type || "").toLowerCase();
    if (type === "connection_init") {
      sendWs(ws, { type: "connection_ack" });
      ws.keepAliveTimer = setInterval(() => sendWs(ws, { type: "ka" }), 25000);
      return;
    }

    if (type === "start") {
      const payload = message?.payload || {};
      const parsed = parseGraphQLPayload(payload);
      const sub = {
        id: String(message.id),
        rootField: parsed.rootField,
        responseKey: parsed.responseKey,
        variables: payload?.variables && typeof payload.variables === "object" ? payload.variables : {},
      };

      const registry = wsSubscriptions.get(ws);
      if (registry) registry.set(sub.id, sub);

      const initial = getInitialSubscriptionPayload(sub);
      if (typeof initial !== "undefined") {
        sendSubscriptionData(ws, sub, initial);
      }
      return;
    }

    if (type === "stop") {
      const registry = wsSubscriptions.get(ws);
      if (registry) registry.delete(String(message.id));
      sendWs(ws, { type: "complete", id: String(message.id) });
      return;
    }

    if (type === "connection_terminate") ws.close();
  });

  ws.on("close", () => {
    const registry = wsSubscriptions.get(ws);
    if (registry) registry.clear();
    wsSubscriptions.delete(ws);
    if (ws.keepAliveTimer) clearInterval(ws.keepAliveTimer);
  });
});

server.listen(PORT, () => {
  console.log(`[backend] listening on http://localhost:${PORT}`);
  console.log("[backend] GraphQL endpoint: /graphql");
  console.log("[backend] WebSocket endpoint: /graphql");
  console.log("[backend] demo user: demo@enatega.local / 12345678");
});

setInterval(() => {
  const rider = state.riders[0];
  if (!rider) return;
  const [lng, lat] = rider.location.coordinates;
  rider.location.coordinates = [
    Number((lng + randomDelta()).toFixed(6)),
    Number((lat + randomDelta()).toFixed(6)),
  ];
  publishRiderLocation(rider);
}, RIDER_TICK_MS);

function resolveField({ rootField, variables, currentUser, operationType }) {
  const key = rootField.toLowerCase();

  switch (key) {
    case "configuration":
      return clone(state.configuration);
    case "getdashboardusers":
      return getDashboardUsers();
    case "getdashboardusersbyyear":
      return getDashboardUsersByYear(variables?.year);
    case "getdashboardordersbytype":
      return getDashboardOrdersByType();
    case "getdashboardsalesbytype":
      return getDashboardSalesByType();
    case "fetchallshoptypes":
      return { data: clone(state.shopTypes) };
    case "attachedcuisines":
    case "cuisines":
    case "nearbyrestaurantscuisines":
      return clone(state.cuisines);
    case "banners":
      return clone(state.banners);
    case "zones":
      return clone(state.zones);
    case "tips":
      return clone(state.tips);
    case "taxes":
      return clone(state.taxes);
    case "nearbyrestaurants":
    case "nearbyrestaurantspreview":
      return buildNearbyRestaurants();
    case "topratedvendors":
    case "topratedvendorspreview":
      return getTopRatedRestaurants();
    case "recentorderrestaurants":
    case "recentorderrestaurantspreview":
      return getRecentOrderRestaurants(currentUser);
    case "mostorderedrestaurants":
    case "mostorderedrestaurantspreview":
      return getMostOrderedRestaurants();
    case "restaurant":
      return clone(findRestaurant(variables?.id, variables?.slug));
    case "relateditems":
      return getRelatedItems(variables?.itemId, variables?.restaurantId);
    case "fetchcategorydetailsbystoreid":
      return getCategoryDetailsByStore(variables?.storeId);
    case "fetchcategorydetailsbystoreidformobile":
      return getCategoryDetailsByStoreMobile(variables?.storeId);
    case "popularitems":
      return getPopularItems(variables?.restaurantId);
    case "popularfooditems":
      return getPopularFoods(variables?.restaurantId);
    case "subcategories":
      return clone(state.subCategories);
    case "subcategoriesbyparentid":
      return clone(
        state.subCategories.filter(
          (item) => String(item.parentCategoryId) === String(variables?.parentCategoryId),
        ),
      );
    case "reviewsbyrestaurant":
      return getReviewsByRestaurant(variables?.restaurant);
    case "profile":
      return buildProfile(currentUser);
    case "users":
      return state.users.map((user) => toSimpleUser(user));
    case "userfavourite":
      return getFavouriteRestaurants(currentUser);
    case "orders":
      return getOrdersForUser(currentUser);
    case "getuserspastorders":
      return getOrdersForUser(currentUser).filter((order) => !ACTIVE_ORDER_STATUSES.has(order.orderStatus));
    case "getusersactiveorders":
      return getOrdersForUser(currentUser).filter((order) => ACTIVE_ORDER_STATUSES.has(order.orderStatus));
    case "order":
      return clone(findOrder(variables?.id));
    case "orderdetails":
      return clone(findOrder(variables?.orderDetailsId || variables?.id));
    case "rider":
      return clone(findRider(variables?.id) || state.riders[0]);
    case "chat":
      return clone(state.chats[String(variables?.order || "")] || []);
    case "getcountries":
      return clone(state.countries);
    case "getcitiesbycountry":
      return clone(getCitiesByCountry(variables?.id));
    case "getcountrybyiso":
      return clone(state.countryByIso[String(variables?.iso || "").toUpperCase()] || { cities: [] });
    case "getversions":
      return clone(state.versions);
    case "metricsgeneral":
      return createPublicMetricsToken();
    case "login":
      return loginUser(variables);
    case "ownerlogin":
      return loginOwner(variables);
    case "createuser":
      return createUser(variables);
    case "updateuser":
      return updateUser(currentUser, variables?.updateUserInput || variables || {});
    case "emailexist":
      return checkEmail(variables?.email);
    case "phoneexist":
      return checkPhone(variables?.phone);
    case "sendotptoemail":
    case "sendotptophonenumber":
    case "verifyotp":
    case "forgotpassword":
      return { result: true };
    case "resetpassword":
      return resetPassword(variables?.email, variables?.password);
    case "deactivate":
    case "deactivated":
      return deactivateUser(currentUser, variables?.email, variables?.isActive);
    case "createaddress":
      return createAddress(currentUser, variables?.addressInput);
    case "editaddress":
      return editAddress(currentUser, variables?.addressInput);
    case "selectaddress":
      return selectAddress(currentUser, variables?.id);
    case "deleteaddress":
      return deleteAddress(currentUser, variables?.id);
    case "deletebulkaddresses":
      return deleteBulkAddresses(currentUser, variables?.ids);
    case "addfavourite":
      return toggleFavourite(currentUser, variables?.id);
    case "placeorder":
      return placeOrder(currentUser, variables);
    case "revieworder":
      return reviewOrder(variables);
    case "abortorder":
      return abortOrder(variables?.id);
    case "coupon":
      return validateCoupon(variables?.coupon, variables?.restaurantId);
    case "updatenotificationstatus":
      return updateNotificationStatus(currentUser, variables);
    case "savenotificationtokenweb":
    case "pushtoken":
      return saveNotificationToken(currentUser, variables?.token);
    case "sendchatmessage":
      return sendChatMessage(currentUser, variables);
    case "createactivity":
      return true;
    case "uploadimagetos3":
      return `https://picsum.photos/seed/${randomId("upload")}/900/600`;
    default:
      return buildFallback(rootField, operationType, currentUser);
  }
}

function parseGraphQLPayload(payload) {
  const query = typeof payload?.query === "string" ? payload.query : "";
  const operationName = typeof payload?.operationName === "string" ? payload.operationName : "";
  const variables = payload?.variables && typeof payload.variables === "object" ? payload.variables : {};
  const operationType = getOperationType(query, operationName);
  const rootSelection = getRootSelection(query, operationName);

  return {
    operationType,
    variables,
    rootField: rootSelection.fieldName,
    responseKey: rootSelection.responseKey,
  };
}

function getOperationType(query, operationName) {
  const source = String(query || "");
  if (operationName) {
    const pattern = new RegExp(
      `\\b(query|mutation|subscription)\\s+${escapeRegex(operationName)}\\b`,
      "i",
    );
    const match = source.match(pattern);
    if (match?.[1]) return match[1].toLowerCase();
  }

  const match = source.match(/\b(query|mutation|subscription)\b/i);
  if (match?.[1]) return match[1].toLowerCase();
  return "query";
}

function getRootSelection(query, operationName) {
  const source = String(query || "");
  if (!source.trim()) return { responseKey: "result", fieldName: "result" };

  const operation = locateOperation(source, operationName);
  const startAt = operation ? operation.endIndex : 0;
  const firstBrace = source.indexOf("{", startAt);
  if (firstBrace < 0) {
    return { responseKey: operationName || "result", fieldName: operationName || "result" };
  }

  let index = skipIgnored(source, firstBrace + 1);
  const aliasOrField = readName(source, index);
  if (!aliasOrField) return { responseKey: "result", fieldName: "result" };

  index = skipIgnored(source, index + aliasOrField.length);
  if (source[index] === ":") {
    index = skipIgnored(source, index + 1);
    const fieldName = readName(source, index) || aliasOrField;
    return { responseKey: aliasOrField, fieldName };
  }

  return { responseKey: aliasOrField, fieldName: aliasOrField };
}

function locateOperation(source, operationName) {
  if (operationName) {
    const pattern = new RegExp(
      `\\b(query|mutation|subscription)\\s+${escapeRegex(operationName)}\\b`,
      "i",
    );
    const match = pattern.exec(source);
    if (match) return { endIndex: match.index + match[0].length };
  }

  const generic = /\b(query|mutation|subscription)\b/i.exec(source);
  if (generic) return { endIndex: generic.index + generic[0].length };
  return null;
}

function skipIgnored(source, start) {
  let index = start;
  while (index < source.length) {
    const char = source[index];
    if (char === " " || char === "\n" || char === "\r" || char === "\t" || char === ",") {
      index += 1;
      continue;
    }
    if (char === "#") {
      while (index < source.length && source[index] !== "\n") index += 1;
      continue;
    }
    break;
  }
  return index;
}

function readName(source, start) {
  let index = start;
  let text = "";
  while (index < source.length) {
    const char = source[index];
    if (/[A-Za-z0-9_]/.test(char)) {
      text += char;
      index += 1;
      continue;
    }
    break;
  }
  return text;
}

function escapeRegex(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function getCurrentUser(headers) {
  const token = parseBearer(headers?.authorization || headers?.Authorization || "");
  if (token && state.tokens.has(token)) {
    const userId = state.tokens.get(token);
    const user = state.users.find((item) => item._id === userId);
    if (user) return user;
  }

  const userIdHeader = headers?.userid || headers?.userId || headers?.["x-user-id"];
  if (userIdHeader) {
    const user = state.users.find((item) => item._id === String(userIdHeader));
    if (user) return user;
  }

  return state.users[0];
}

function parseBearer(value) {
  const text = String(value || "");
  const match = text.match(/Bearer\s+(.+)/i);
  return match ? match[1].trim() : "";
}

function issueUserToken(userId) {
  const token = Buffer.from(
    `${userId}:${Date.now()}:${crypto.randomBytes(8).toString("hex")}`,
  ).toString("base64url");
  state.tokens.set(token, userId);
  return token;
}

function createPublicMetricsToken() {
  return {
    excellence: "ok",
    topgun: randomId("tg"),
    experience: `pub_${crypto.randomBytes(18).toString("hex")}`,
    skydiver: randomId("sd"),
    rider: randomId("rd"),
    haha: randomId("ha"),
    hehe: futureIso(PUBLIC_TOKEN_TTL_MS),
    huhu: randomId("hu"),
    yoyo: randomId("yo"),
    turu: randomId("tu"),
  };
}

function loginUser(variables) {
  const email = String(variables?.email || "").trim().toLowerCase();
  let user = email ? state.users.find((item) => item.email.toLowerCase() === email) : null;
  if (!user && variables?.phone) {
    user = state.users.find((item) => item.phone === variables.phone);
  }

  let isNewUser = false;
  if (!user) {
    isNewUser = true;
    user = {
      _id: randomId("usr"),
      name: String(variables?.name || "Customer"),
      email: email || `${randomId("user")}@enatega.local`,
      phone: String(variables?.phone || "+21600000000"),
      password: String(variables?.password || "12345678"),
      phoneIsVerified: true,
      emailIsVerified: true,
      picture: "",
      notificationToken: String(variables?.notificationToken || ""),
      isOrderNotification: true,
      isOfferNotification: true,
      isActive: true,
      userType: "CUSTOMER",
      userTypeId: "customer",
      favourite: [],
      addresses: [],
    };
    state.users.push(user);
  }

  const token = issueUserToken(user._id);
  return toAuthPayload(user, token, isNewUser);
}

function loginOwner(variables) {
  const email = String(variables?.email || "").trim().toLowerCase();
  let user = email ? state.users.find((item) => item.email.toLowerCase() === email) : null;

  if (!user) {
    user = createDemoAdminUser(
      email || `${randomId("admin")}@enatega.local`,
      String(variables?.password || "12345678"),
      randomId("adm"),
    );
    state.users.push(user);
  }

  const token = issueUserToken(user._id);
  return toOwnerAuthPayload(user, token);
}

function createUser(variables) {
  const input = variables?.userInput || variables || {};
  const email = String(input?.email || "").trim().toLowerCase();
  const existing = state.users.find((user) => user.email.toLowerCase() === email);
  if (existing) return toAuthPayload(existing, issueUserToken(existing._id), false);

  const user = {
    _id: randomId("usr"),
    name: String(input?.name || "Customer"),
    email: email || `${randomId("user")}@enatega.local`,
    phone: String(input?.phone || "+21600000000"),
    password: String(input?.password || "12345678"),
    phoneIsVerified: Boolean(input?.isPhoneExists),
    emailIsVerified: Boolean(input?.emailIsVerified),
    picture: "",
    notificationToken: String(input?.notificationToken || ""),
    isOrderNotification: true,
    isOfferNotification: true,
    isActive: true,
    userType: "CUSTOMER",
    userTypeId: "customer",
    favourite: [],
    addresses: [],
  };

  state.users.push(user);
  return toAuthPayload(user, issueUserToken(user._id), true);
}

function updateUser(currentUser, input) {
  if (typeof input?.name === "string") currentUser.name = input.name;
  if (typeof input?.phone === "string") currentUser.phone = input.phone;
  if (typeof input?.phoneIsVerified === "boolean") currentUser.phoneIsVerified = input.phoneIsVerified;
  if (typeof input?.emailIsVerified === "boolean") currentUser.emailIsVerified = input.emailIsVerified;

  return {
    _id: currentUser._id,
    name: currentUser.name,
    phone: currentUser.phone,
    phoneIsVerified: currentUser.phoneIsVerified,
    emailIsVerified: currentUser.emailIsVerified,
  };
}

function checkEmail(email) {
  const normalized = String(email || "").trim().toLowerCase();
  const user = state.users.find((item) => item.email.toLowerCase() === normalized);
  return user ? { _id: user._id, email: user.email, userType: user.userType } : null;
}

function checkPhone(phone) {
  const normalized = String(phone || "").trim();
  const user = state.users.find((item) => item.phone === normalized);
  return user ? { _id: user._id, phone: user.phone, userType: user.userType } : null;
}

function resetPassword(email, password) {
  const normalized = String(email || "").trim().toLowerCase();
  const user = state.users.find((item) => item.email.toLowerCase() === normalized);
  if (user) user.password = String(password || user.password);
  return { result: true };
}

function deactivateUser(currentUser, email, isActive) {
  const normalized = String(email || "").trim().toLowerCase();
  const target = state.users.find((item) => item.email.toLowerCase() === normalized) || currentUser;
  target.isActive = Boolean(isActive);
  return { _id: target._id, name: target.name, email: target.email, isActive: target.isActive };
}

function toAuthPayload(user, token, isNewUser) {
  return {
    userId: user._id,
    token,
    tokenExpiration: futureIso(USER_TOKEN_TTL_MS),
    name: user.name,
    phone: user.phone,
    phoneIsVerified: user.phoneIsVerified,
    email: user.email,
    emailIsVerified: user.emailIsVerified,
    picture: user.picture || "",
    addresses: clone(user.addresses),
    isNewUser,
    userTypeId: user.userTypeId || "customer",
    isActive: user.isActive,
  };
}

function normalizeOwnerUserType(userType) {
  const normalized = String(userType || "").trim().toUpperCase();
  if (normalized === "ADMIN" || normalized === "STAFF" || normalized === "VENDOR" || normalized === "RESTAURANT") {
    return normalized;
  }
  return "ADMIN";
}

function toOwnerRestaurantSummary(restaurant) {
  return {
    _id: restaurant._id,
    orderId: restaurant.orderId || "",
    name: restaurant.name || "",
    image: restaurant.image || "",
    address: restaurant.address || "",
  };
}

function getOwnerRestaurants(user, userType) {
  const userTypeId = String(user?.userTypeId || "");

  if (userType === "RESTAURANT" && userTypeId) {
    const restaurant = state.restaurants.find(
      (item) => String(item._id) === userTypeId || String(item.id) === userTypeId,
    );
    if (restaurant) return [toOwnerRestaurantSummary(restaurant)];
  }

  return state.restaurants.slice(0, 3).map((restaurant) => toOwnerRestaurantSummary(restaurant));
}

function toOwnerAuthPayload(user, token) {
  const userType = normalizeOwnerUserType(user?.userType);
  const restaurants = getOwnerRestaurants(user, userType);

  return {
    userId: user._id,
    token,
    email: user.email,
    name: user.name || "Demo Admin",
    image: user.picture || "",
    userType,
    userTypeId: user.userTypeId || userType.toLowerCase(),
    restaurants,
    permissions: Array.isArray(user.permissions) ? clone(user.permissions) : [],
    shopType: restaurants[0]?.shopType || "food",
  };
}

function getDashboardUsers() {
  const usersCount = state.users.length;
  const vendorsCount = state.users.filter((user) => String(user.userType || "").toUpperCase() === "VENDOR").length;
  const restaurantsCount = state.restaurants.length;
  const ridersCount = state.riders.length;

  return {
    usersCount,
    vendorsCount,
    restaurantsCount,
    ridersCount,
  };
}

function getDashboardUsersByYear(year) {
  const numericYear = Number(year) || new Date().getFullYear();
  const monthBase = Math.max(1, numericYear % 10);
  const makeSeries = (seed) =>
    Array.from({ length: 12 }, (_item, index) => Number((seed + index * 1.7).toFixed(0)));

  return {
    usersCount: makeSeries(monthBase + 10),
    vendorsCount: makeSeries(monthBase + 2),
    restaurantsCount: makeSeries(monthBase + 4),
    ridersCount: makeSeries(monthBase + 1),
    percentageChange: {
      usersPercent: 8.5,
      vendorsPercent: 2.4,
      restaurantsPercent: -6.1,
      ridersPercent: 1.9,
    },
  };
}

function getDashboardOrdersByType() {
  const counters = new Map();
  for (const order of state.orders) {
    const status = String(order?.orderStatus || order?.status || "UNKNOWN").toUpperCase();
    counters.set(status, (counters.get(status) || 0) + 1);
  }

  if (counters.size === 0) {
    return [
      { label: "PENDING", value: 0 },
      { label: "DELIVERED", value: 0 },
      { label: "CANCELLED", value: 0 },
    ];
  }

  return Array.from(counters.entries()).map(([label, value]) => ({
    label,
    value,
  }));
}

function getDashboardSalesByType() {
  const counters = new Map();
  for (const order of state.orders) {
    const method = String(order?.paymentMethod || "OTHER").toUpperCase();
    const amount = Number(order?.paidAmount ?? order?.orderAmount ?? 0);
    counters.set(method, Number((counters.get(method) || 0) + amount));
  }

  if (counters.size === 0) {
    return [
      { label: "COD", value: 0 },
      { label: "CARD", value: 0 },
    ];
  }

  return Array.from(counters.entries()).map(([label, value]) => ({
    label,
    value: Number(value.toFixed(2)),
  }));
}

function createAddress(currentUser, addressInput) {
  const nextAddress = {
    _id: randomId("addr"),
    label: String(addressInput?.label || "Home"),
    deliveryAddress: String(addressInput?.deliveryAddress || "Address"),
    details: String(addressInput?.details || ""),
    location: { coordinates: normalizeCoordinates(addressInput?.location?.coordinates) },
    selected: Boolean(addressInput?.selected ?? currentUser.addresses.length === 0),
  };

  if (nextAddress.selected) {
    for (const address of currentUser.addresses) address.selected = false;
  }
  currentUser.addresses.push(nextAddress);
  return buildAddressPayload(currentUser);
}

function editAddress(currentUser, addressInput) {
  const id = String(addressInput?._id || addressInput?.id || "");
  const target = currentUser.addresses.find((item) => item._id === id);
  if (!target) return createAddress(currentUser, addressInput);

  if (typeof addressInput?.label === "string") target.label = addressInput.label;
  if (typeof addressInput?.deliveryAddress === "string") target.deliveryAddress = addressInput.deliveryAddress;
  if (typeof addressInput?.details === "string") target.details = addressInput.details;
  if (addressInput?.location?.coordinates) {
    target.location.coordinates = normalizeCoordinates(addressInput.location.coordinates);
  }
  if (typeof addressInput?.selected === "boolean") {
    if (addressInput.selected) {
      for (const address of currentUser.addresses) address.selected = false;
    }
    target.selected = addressInput.selected;
  }

  return buildAddressPayload(currentUser);
}

function selectAddress(currentUser, addressId) {
  const id = String(addressId || "");
  for (const address of currentUser.addresses) {
    address.selected = address._id === id;
  }
  return buildAddressPayload(currentUser);
}

function deleteAddress(currentUser, addressId) {
  const id = String(addressId || "");
  currentUser.addresses = currentUser.addresses.filter((address) => address._id !== id);
  if (!currentUser.addresses.some((address) => address.selected) && currentUser.addresses[0]) {
    currentUser.addresses[0].selected = true;
  }
  return buildAddressPayload(currentUser);
}

function deleteBulkAddresses(currentUser, ids) {
  const idSet = new Set((Array.isArray(ids) ? ids : []).map((item) => String(item)));
  currentUser.addresses = currentUser.addresses.filter((address) => !idSet.has(address._id));
  if (!currentUser.addresses.some((address) => address.selected) && currentUser.addresses[0]) {
    currentUser.addresses[0].selected = true;
  }
  return buildAddressPayload(currentUser);
}

function toggleFavourite(currentUser, restaurantId) {
  const id = String(restaurantId || "");
  const index = currentUser.favourite.findIndex((value) => value === id);
  if (index >= 0) currentUser.favourite.splice(index, 1);
  else currentUser.favourite.push(id);
  return buildAddressPayload(currentUser);
}

function buildAddressPayload(user) {
  return {
    _id: user._id,
    addresses: clone(user.addresses),
  };
}

function placeOrder(currentUser, variables) {
  const restaurant = findRestaurant(variables?.restaurant);
  const items = buildOrderItems(restaurant, variables?.orderInput);
  const address = variables?.address || currentUser.addresses[0];
  const rider = state.riders[0];

  const orderAmount = items.reduce((sum, item) => sum + item.quantity * safeNumber(item.variation?.price, 0), 0);
  const tipping = safeNumber(variables?.tipping, 0);
  const taxationAmount = safeNumber(variables?.taxationAmount, 0);
  const deliveryCharges = safeNumber(variables?.deliveryCharges, 3);

  const order = {
    _id: randomId("ord"),
    id: "",
    orderId: String(10000 + state.orders.length + 1),
    restaurant: buildOrderRestaurant(restaurant),
    deliveryAddress: buildDeliveryAddress(address),
    items,
    user: buildOrderUser(currentUser),
    rider: buildOrderRider(rider),
    review: null,
    paymentMethod: String(variables?.paymentMethod || "COD"),
    paidAmount: Number((orderAmount + tipping + taxationAmount + deliveryCharges).toFixed(2)),
    orderAmount: Number(orderAmount.toFixed(2)),
    discountAmount: 0,
    orderStatus: "PENDING",
    status: "PENDING",
    paymentStatus: "PENDING",
    tipping,
    taxationAmount,
    createdAt: nowIso(),
    completionTime: null,
    preparationTime: 25,
    orderDate: String(variables?.orderDate || nowIso()),
    expectedTime: futureIso(30 * 60 * 1000),
    isPickedUp: Boolean(variables?.isPickedUp || false),
    deliveryCharges,
    acceptedAt: null,
    pickedAt: null,
    deliveredAt: null,
    cancelledAt: null,
    assignedAt: nowIso(),
    instructions: String(variables?.instructions || ""),
    reason: null,
    selectedPrepTime: 25,
  };
  order.id = order._id;
  state.orders.unshift(order);

  publishOrderUpdate(order, "NEW_ORDER");
  scheduleOrderProgress(order._id);
  return clone(order);
}

function reviewOrder(variables) {
  const input = variables?.reviewInput || variables || {};
  const order = findOrder(input?.order || variables?.order);
  if (!order) return null;

  order.review = {
    _id: randomId("rev"),
    rating: safeNumber(input?.rating || variables?.rating, 5),
    description: String(input?.description || variables?.description || ""),
    comments: String(input?.comments || variables?.comments || ""),
    isActive: true,
    createdAt: nowIso(),
    updatedAt: nowIso(),
  };
  if (order.orderStatus !== "DELIVERED") {
    order.orderStatus = "DELIVERED";
    order.status = "DELIVERED";
    order.deliveredAt = nowIso();
    order.completionTime = nowIso();
  }

  publishOrderUpdate(order, "ORDER_REVIEWED");
  return clone(order);
}

function abortOrder(orderId) {
  const order = findOrder(orderId);
  if (!order) return null;
  order.orderStatus = "CANCELLED";
  order.status = "CANCELLED";
  order.cancelledAt = nowIso();
  order.reason = "Cancelled by user";
  publishOrderUpdate(order, "ORDER_CANCELLED");
  return clone(order);
}

function validateCoupon(code, restaurantId) {
  const couponCode = String(code || "").trim().toUpperCase();
  const restaurant = String(restaurantId || "");
  const coupon = state.coupons.find(
    (item) =>
      item.enabled &&
      item.title.toUpperCase() === couponCode &&
      (!item.restaurantId || item.restaurantId === restaurant),
  );

  if (!coupon) return { success: false, message: "Invalid coupon code", coupon: null };
  return { success: true, message: "Coupon applied", coupon: clone(coupon) };
}

function updateNotificationStatus(currentUser, variables) {
  if (typeof variables?.orderNotification === "boolean") {
    currentUser.isOrderNotification = variables.orderNotification;
  }
  if (typeof variables?.offerNotification === "boolean") {
    currentUser.isOfferNotification = variables.offerNotification;
  }
  return {
    _id: currentUser._id,
    name: currentUser.name,
    phone: currentUser.phone,
    notificationToken: currentUser.notificationToken,
    isOrderNotification: currentUser.isOrderNotification,
    isOfferNotification: currentUser.isOfferNotification,
  };
}

function saveNotificationToken(currentUser, token) {
  currentUser.notificationToken = String(token || "");
  return {
    _id: currentUser._id,
    notificationToken: currentUser.notificationToken,
    success: true,
    message: "Notification token saved",
  };
}

function sendChatMessage(currentUser, variables) {
  const orderId = String(variables?.orderId || "");
  const input = variables?.messageInput || {};
  const message = {
    id: randomId("msg"),
    message: String(input?.message || ""),
    user: { id: currentUser._id, name: currentUser.name },
    createdAt: nowIso(),
  };

  if (!state.chats[orderId]) state.chats[orderId] = [];
  state.chats[orderId].push(message);
  publishChatMessage(orderId, message);

  return {
    success: true,
    message: "Message sent",
    data: clone(message),
  };
}

function buildProfile(user) {
  return {
    _id: user._id,
    name: user.name,
    phone: user.phone,
    phoneIsVerified: user.phoneIsVerified,
    email: user.email,
    emailIsVerified: user.emailIsVerified,
    notificationToken: user.notificationToken,
    isOrderNotification: user.isOrderNotification,
    isOfferNotification: user.isOfferNotification,
    addresses: clone(user.addresses),
    favourite: clone(user.favourite),
  };
}

function toSimpleUser(user) {
  return {
    _id: user._id,
    id: user._id,
    name: user.name,
    email: user.email,
    phone: user.phone,
    isActive: user.isActive,
    userType: user.userType,
  };
}

function findRestaurant(id, slug) {
  const idValue = String(id || "");
  const slugValue = String(slug || "");
  if (idValue) {
    const byId = state.restaurants.find((item) => item._id === idValue);
    if (byId) return byId;
  }
  if (slugValue) {
    const bySlug = state.restaurants.find((item) => item.slug === slugValue);
    if (bySlug) return bySlug;
  }
  return state.restaurants[0];
}

function findOrder(id) {
  const value = String(id || "");
  if (!value) return state.orders[0] || null;
  return (
    state.orders.find(
      (order) => order._id === value || order.id === value || String(order.orderId) === value,
    ) || null
  );
}

function findRider(id) {
  const value = String(id || "");
  if (!value) return state.riders[0] || null;
  return state.riders.find((item) => item._id === value) || null;
}

function getOrdersForUser(user) {
  return state.orders.filter((order) => order.user._id === user._id).map((order) => clone(order));
}

function buildNearbyRestaurants() {
  const restaurantIds = state.restaurants.map((restaurant) => restaurant._id);
  return {
    offers: [{ _id: "offer-1", name: "Popular", tag: "hot", restaurants: restaurantIds }],
    sections: [{ _id: "section-1", name: "Recommended", restaurants: restaurantIds }],
    restaurants: clone(state.restaurants),
  };
}

function getTopRatedRestaurants() {
  return [...state.restaurants]
    .sort((left, right) => safeNumber(right.reviewAverage) - safeNumber(left.reviewAverage))
    .map((restaurant) => clone(restaurant));
}

function getRecentOrderRestaurants(user) {
  const ids = new Set(
    state.orders
      .filter((order) => order.user._id === user._id)
      .map((order) => order.restaurant._id),
  );
  const selected = ids.size === 0
    ? state.restaurants.slice(0, 4)
    : state.restaurants.filter((restaurant) => ids.has(restaurant._id));
  return selected.map((restaurant) => clone(restaurant));
}

function getMostOrderedRestaurants() {
  const counts = new Map();
  for (const order of state.orders) {
    const current = counts.get(order.restaurant._id) || 0;
    counts.set(order.restaurant._id, current + 1);
  }
  return [...state.restaurants]
    .sort((left, right) => (counts.get(right._id) || 0) - (counts.get(left._id) || 0))
    .map((restaurant) => clone(restaurant));
}

function getRelatedItems(itemId, restaurantId) {
  const restaurant = findRestaurant(restaurantId);
  const ids = restaurant.categories.flatMap((category) => category.foods.map((food) => food._id));
  return ids.filter((id) => id !== itemId).slice(0, 8);
}

function getCategoryDetailsByStore(storeId) {
  const restaurant = findRestaurant(storeId);
  return restaurant.categories.map((category) => ({
    id: category._id,
    label: category.title,
    url: `/${restaurant.slug}/categories/${category._id}`,
    items: category.foods.map((food) => ({
      id: food._id,
      label: food.title,
      url: `/${restaurant.slug}/foods/${food._id}`,
    })),
  }));
}

function getCategoryDetailsByStoreMobile(storeId) {
  const restaurant = findRestaurant(storeId);
  const response = [];
  for (const category of restaurant.categories) {
    for (const food of category.foods) {
      response.push({
        id: category._id,
        category_name: category.title,
        url: `/${restaurant.slug}/foods/${food._id}`,
        food_id: food._id,
      });
    }
  }
  return response;
}

function getPopularItems(restaurantId) {
  const restaurant = findRestaurant(restaurantId);
  const counts = new Map();
  for (const order of state.orders.filter((item) => item.restaurant._id === restaurant._id)) {
    for (const item of order.items) {
      const current = counts.get(item.food) || 0;
      counts.set(item.food, current + item.quantity);
    }
  }
  return [...counts.entries()].map(([id, count]) => ({ id, count })).slice(0, 10);
}

function getPopularFoods(restaurantId) {
  const restaurant = findRestaurant(restaurantId);
  const foods = restaurant.categories.flatMap((category) => category.foods);
  return clone(foods.slice(0, 8));
}

function getReviewsByRestaurant(restaurantId) {
  const reviews = [];
  for (const order of state.orders) {
    if (String(order.restaurant._id) !== String(restaurantId)) continue;
    if (!order.review) continue;
    reviews.push({
      _id: order.review._id,
      rating: order.review.rating,
      description: order.review.description,
      comments: order.review.comments || "",
      isActive: true,
      createdAt: order.review.createdAt || order.createdAt,
      updatedAt: order.review.updatedAt || order.createdAt,
      order: {
        _id: order._id,
        user: {
          _id: order.user._id,
          name: order.user.name,
          email: state.users.find((item) => item._id === order.user._id)?.email || "",
        },
      },
      restaurant: {
        _id: order.restaurant._id,
        name: order.restaurant.name,
      },
    });
  }

  const total = reviews.length;
  const ratings = total === 0
    ? 0
    : Number(
      (
        reviews.reduce((sum, review) => sum + safeNumber(review.rating), 0) /
        total
      ).toFixed(1),
    );
  return { reviews, ratings, total };
}

function getFavouriteRestaurants(user) {
  return state.restaurants
    .filter((restaurant) => user.favourite.includes(restaurant._id))
    .map((restaurant) => clone(restaurant));
}

function getCitiesByCountry(countryId) {
  const id = String(countryId || "");
  const country = state.countryCities.find((item) => item.id === id);
  return country ? country : { id: "", name: "", cities: [] };
}

function buildOrderItems(restaurant, input) {
  const items = Array.isArray(input) ? input : [];
  const allFoods = restaurant.categories.flatMap((category) => category.foods);
  if (items.length === 0) {
    const fallback = allFoods[0];
    return fallback ? [createOrderItem(fallback, 1, null)] : [];
  }
  return items.map((item) => {
    const foodId = String(item?.food || item?._id || item?.id || "");
    const food = allFoods.find((entry) => entry._id === foodId) || allFoods[0];
    const quantity = Math.max(1, safeNumber(item?.quantity, 1));
    const variationId = String(item?.variation?._id || item?.variation || "");
    return createOrderItem(food, quantity, variationId);
  });
}

function createOrderItem(food, quantity, variationId) {
  const variation = food.variations.find((item) => item._id === variationId) || food.variations[0];
  return {
    _id: randomId("itm"),
    id: randomId("itm"),
    title: food.title,
    food: food._id,
    description: food.description,
    quantity,
    image: food.image,
    variation: {
      _id: variation._id,
      id: variation._id,
      title: variation.title,
      price: variation.price,
      discounted: variation.discounted,
    },
    addons: [],
    specialInstructions: "",
    isActive: true,
    createdAt: nowIso(),
    updatedAt: nowIso(),
  };
}

function buildOrderRestaurant(restaurant) {
  return {
    _id: restaurant._id,
    name: restaurant.name,
    slug: restaurant.slug,
    shopType: restaurant.shopType,
    image: restaurant.image,
    address: restaurant.address,
    location: clone(restaurant.location),
  };
}

function buildDeliveryAddress(input) {
  const id = String(input?._id || input?.id || randomId("addr"));
  return {
    _id: id,
    id,
    location: { coordinates: normalizeCoordinates(input?.location?.coordinates) },
    deliveryAddress: String(input?.deliveryAddress || "Delivery Address"),
    details: String(input?.details || ""),
    label: String(input?.label || "Home"),
  };
}

function buildOrderUser(user) {
  return {
    _id: user._id,
    name: user.name,
    phone: user.phone,
    email: user.email,
  };
}

function buildOrderRider(rider) {
  if (!rider) return { _id: "", name: "", phone: "" };
  return { _id: rider._id, name: rider.name, phone: rider.phone };
}

function normalizeCoordinates(coordinates) {
  if (Array.isArray(coordinates) && coordinates.length >= 2) {
    return [safeNumber(coordinates[0], 10.1815), safeNumber(coordinates[1], 36.8065)];
  }
  return [10.1815, 36.8065];
}

function scheduleOrderProgress(orderId) {
  setTimeout(() => updateOrderStatus(orderId, "ACCEPTED"), 15000);
  setTimeout(() => updateOrderStatus(orderId, "PICKED"), 35000);
  setTimeout(() => updateOrderStatus(orderId, "DELIVERED"), 90000);
}

function updateOrderStatus(orderId, status) {
  const order = findOrder(orderId);
  if (!order) return;
  if (order.orderStatus === "CANCELLED") return;

  order.orderStatus = status;
  order.status = status;
  if (status === "ACCEPTED") order.acceptedAt = nowIso();
  if (status === "PICKED") {
    order.pickedAt = nowIso();
    order.isPickedUp = true;
  }
  if (status === "DELIVERED") {
    order.deliveredAt = nowIso();
    order.completionTime = nowIso();
    order.paymentStatus = "PAID";
  }
  publishOrderUpdate(order, "ORDER_STATUS_UPDATED");
}

function buildFallback(rootField, operationType, currentUser) {
  const key = rootField.toLowerCase();
  if (key.includes("restaurant")) return key.endsWith("s") ? clone(state.restaurants) : clone(state.restaurants[0]);
  if (key.includes("order")) return key.endsWith("s") ? clone(state.orders) : clone(state.orders[0] || null);
  if (key.includes("rider")) return key.endsWith("s") ? clone(state.riders) : clone(state.riders[0]);
  if (key.includes("user")) return key.endsWith("s") ? state.users.map((user) => toSimpleUser(user)) : toSimpleUser(currentUser);
  if (operationType === "mutation") return { success: true, message: `${rootField} handled in fallback mode` };
  if (key.startsWith("get") || key.endsWith("s")) return [];
  return { _id: randomId("fallback"), value: rootField };
}

function getInitialSubscriptionPayload(sub) {
  const key = sub.rootField.toLowerCase();
  if (key === "subscriptionorder") return findOrder(sub.variables?.id);
  if (key === "subscriptionriderlocation") return findRider(sub.variables?.riderId) || state.riders[0];
  if (key === "subscriptionnewmessage") {
    const orderId = String(sub.variables?.order || "");
    const messages = state.chats[orderId] || [];
    return messages[messages.length - 1] || null;
  }
  if (key === "orderstatuschanged") {
    const order = state.orders[0];
    if (!order) return null;
    return { userId: order.user._id, origin: "INITIAL", order: clone(order) };
  }
  if (key === "subscribeplaceorder" || key === "subscriptionzoneorders") return clone(state.orders[0] || null);
  return null;
}

function publishOrderUpdate(order, origin) {
  forEachSubscription((ws, sub) => {
    const key = sub.rootField.toLowerCase();
    if (key === "subscriptionorder") {
      if (sameId(order._id, sub.variables?.id) || sameId(order.orderId, sub.variables?.id)) {
        sendSubscriptionData(ws, sub, {
          _id: order._id,
          orderStatus: order.orderStatus,
          rider: { _id: order.rider?._id || "" },
          completionTime: order.completionTime,
          preparationTime: order.preparationTime,
        });
      }
      return;
    }
    if (key === "orderstatuschanged") {
      if (sameId(order.user?._id, sub.variables?.userId)) {
        sendSubscriptionData(ws, sub, {
          userId: order.user?._id || "",
          origin,
          order: clone(order),
        });
      }
      return;
    }
    if (key === "subscribeplaceorder") {
      if (!sub.variables?.restaurant || sameId(order.restaurant?._id, sub.variables?.restaurant)) {
        sendSubscriptionData(ws, sub, clone(order));
      }
      return;
    }
    if (key === "subscriptiondispatcher" || key === "subscriptionzoneorders") {
      sendSubscriptionData(ws, sub, clone(order));
      return;
    }
    if (key === "subscriptionassignrider") {
      if (!sub.variables?.riderId || sameId(order.rider?._id, sub.variables?.riderId)) {
        sendSubscriptionData(ws, sub, clone(order));
      }
    }
  });
}

function publishChatMessage(orderId, message) {
  forEachSubscription((ws, sub) => {
    if (sub.rootField.toLowerCase() !== "subscriptionnewmessage") return;
    if (!sameId(orderId, sub.variables?.order)) return;
    sendSubscriptionData(ws, sub, clone(message));
  });
}

function publishRiderLocation(rider) {
  forEachSubscription((ws, sub) => {
    const key = sub.rootField.toLowerCase();
    if (key === "subscriptionriderlocation") {
      if (!sub.variables?.riderId || sameId(rider._id, sub.variables?.riderId)) {
        sendSubscriptionData(ws, sub, clone(rider));
      }
      return;
    }
    if (key === "riderupdated") {
      sendSubscriptionData(ws, sub, clone(rider));
    }
  });
}

function forEachSubscription(callback) {
  for (const [ws, registry] of wsSubscriptions.entries()) {
    if (ws.readyState !== WebSocket.OPEN) continue;
    for (const sub of registry.values()) callback(ws, sub);
  }
}

function sendSubscriptionData(ws, sub, value) {
  sendWs(ws, {
    type: "data",
    id: sub.id,
    payload: { data: { [sub.responseKey]: value } },
  });
}

function sendWs(ws, payload) {
  if (ws.readyState !== WebSocket.OPEN) return;
  ws.send(JSON.stringify(payload));
}

function sameId(left, right) {
  if (!left || !right) return false;
  return String(left) === String(right);
}

function createInitialState() {
  const openingTimes = createOpeningTimes();
  const restaurants = [
    createRestaurantOne(openingTimes),
    createRestaurantTwo(openingTimes),
    createRestaurantThree(openingTimes),
  ];
  const users = [createDemoUser(), createDemoAdminUser()];
  const riders = [createDemoRider()];
  const orders = [
    createSeedOrderOne(restaurants, users, riders),
    createSeedOrderTwo(restaurants, users, riders),
  ];

  return {
    users,
    tokens: new Map(),
    restaurants,
    riders,
    orders,
    chats: {
      "ord-1": [
        {
          id: "msg-1",
          message: "Hello, your order is being prepared.",
          user: { id: "res-1", name: "Central Kitchen" },
          createdAt: nowIso(),
        },
      ],
    },
    coupons: [
      { _id: "coupon-1", title: "WELCOME10", discount: 10, enabled: true, restaurantId: "res-1" },
      { _id: "coupon-2", title: "PIZZA5", discount: 5, enabled: true, restaurantId: "res-2" },
    ],
    configuration: {
      _id: "cfg-1",
      currency: "USD",
      currencySymbol: "$",
      deliveryRate: 1.2,
      twilioEnabled: false,
      webClientID: "",
      androidClientID: "",
      iOSClientID: "",
      appAmplitudeApiKey: "",
      webAmplitudeApiKey: "",
      googleApiKey: "",
      googleMapLibraries: "places,drawing,geometry,visualization",
      googleColor: "#2E7D32",
      webSentryUrl: "",
      dashboardSentryUrl: "",
      apiSentryUrl: "",
      customerAppSentryUrl: "",
      restaurantAppSentryUrl: "",
      riderAppSentryUrl: "",
      publishableKey: "pk_test_local",
      secretKey: "sk_test_local",
      clientId: "paypal_client_local",
      clientSecret: "paypal_secret_local",
      sandbox: true,
      skipEmailVerification: true,
      skipMobileVerification: true,
      skipWhatsAppOTP: true,
      costType: "perKM",
      firebaseKey: "",
      authDomain: "",
      projectId: "",
      storageBucket: "",
      msgSenderId: "",
      appId: "",
      measurementId: "",
      vapidKey: "",
      termsAndConditions: "https://enatega.local/terms",
      privacyPolicy: "https://enatega.local/privacy",
      testOtp: "1234",
      password: "",
      emailName: "",
      email: "",
      enableEmail: false,
      twilioAccountSid: "",
      twilioAuthToken: "",
      twilioPhoneNumber: "",
      twilioWhatsAppNumber: "",
      cloudinaryUploadUrl: "",
      cloudinaryApiKey: "",
      expoClientID: "",
      isPaidVersion: false,
    },
    zones: [
      {
        _id: "zone-1",
        title: "Tunis Center",
        description: "Downtown delivery zone",
        location: { coordinates: [10.1815, 36.8065] },
        isActive: true,
      },
      {
        _id: "zone-2",
        title: "Lac 2",
        description: "Lac district delivery zone",
        location: { coordinates: [10.22, 36.845] },
        isActive: true,
      },
    ],
    banners: [
      {
        _id: "bnr-1",
        title: "Lunch Deals",
        description: "Daily lunch specials",
        action: "OPEN_RESTAURANT",
        screen: "Restaurant",
        file: "https://picsum.photos/seed/banner1/1200/360",
        parameters: JSON.stringify({ restaurantId: "res-1" }),
        slug: "lunch-deals",
        shopType: "food",
      },
    ],
    cuisines: [
      { _id: "cui-1", name: "Italian", description: "Pizza and pasta", image: "https://picsum.photos/seed/cui1/320/240", shopType: "food" },
      { _id: "cui-2", name: "American", description: "Burgers and fries", image: "https://picsum.photos/seed/cui2/320/240", shopType: "food" },
      { _id: "cui-3", name: "Healthy", description: "Fresh salads and bowls", image: "https://picsum.photos/seed/cui3/320/240", shopType: "grocery" },
    ],
    tips: [{ _id: "tip-1", tipVariations: [0, 1, 2, 3, 5], enabled: true }],
    taxes: [{ _id: "tax-1", taxationCharges: 14, enabled: true }],
    shopTypes: [
      { _id: "type-food", image: "https://picsum.photos/seed/typefood/180/120", name: "Food", slug: "food" },
      { _id: "type-grocery", image: "https://picsum.photos/seed/typegrocery/180/120", name: "Grocery", slug: "grocery" },
    ],
    subCategories: [
      { _id: "sub-burger", title: "Burgers", parentCategoryId: "cat-main" },
      { _id: "sub-pizza", title: "Pizzas", parentCategoryId: "cat-main" },
      { _id: "sub-dessert", title: "Desserts", parentCategoryId: "cat-dessert" },
    ],
    countries: [
      { _id: "country-tn", name: "Tunisia", flag: "tn" },
      { _id: "country-us", name: "United States", flag: "us" },
    ],
    countryCities: [
      {
        id: "country-tn",
        name: "Tunisia",
        cities: [
          { id: "city-tunis", name: "Tunis", latitude: 36.8065, longitude: 10.1815 },
          { id: "city-sfax", name: "Sfax", latitude: 34.7406, longitude: 10.7603 },
        ],
      },
      {
        id: "country-us",
        name: "United States",
        cities: [
          { id: "city-nyc", name: "New York", latitude: 40.7128, longitude: -74.006 },
          { id: "city-la", name: "Los Angeles", latitude: 34.0522, longitude: -118.2437 },
        ],
      },
    ],
    countryByIso: {
      TN: {
        cities: [
          { id: "city-tunis", name: "Tunis", latitude: 36.8065, longitude: 10.1815 },
          { id: "city-sfax", name: "Sfax", latitude: 34.7406, longitude: 10.7603 },
        ],
      },
      US: {
        cities: [
          { id: "city-nyc", name: "New York", latitude: 40.7128, longitude: -74.006 },
          { id: "city-la", name: "Los Angeles", latitude: 34.0522, longitude: -118.2437 },
        ],
      },
    },
    versions: {
      customerAppVersion: { android: "1.0.0", ios: "1.0.0" },
      riderAppVersion: { android: "1.0.0", ios: "1.0.0" },
      restaurantAppVersion: { android: "1.0.0", ios: "1.0.0" },
    },
  };
}

function createOpeningTimes() {
  return [
    { day: "MONDAY", times: [{ startTime: "09:00", endTime: "23:00" }] },
    { day: "TUESDAY", times: [{ startTime: "09:00", endTime: "23:00" }] },
    { day: "WEDNESDAY", times: [{ startTime: "09:00", endTime: "23:00" }] },
    { day: "THURSDAY", times: [{ startTime: "09:00", endTime: "23:00" }] },
    { day: "FRIDAY", times: [{ startTime: "09:00", endTime: "23:00" }] },
    { day: "SATURDAY", times: [{ startTime: "10:00", endTime: "00:00" }] },
    { day: "SUNDAY", times: [{ startTime: "10:00", endTime: "00:00" }] },
  ];
}

function createRestaurantBase({
  id,
  name,
  slug,
  address,
  location,
  deliveryTime,
  minimumOrder,
  rating,
  reviewCount,
  shopType,
  cuisines,
  categories,
  openingTimes,
}) {
  return {
    _id: id,
    id,
    orderId: String(1000 + safeNumber(id.split("-")[1], 0)),
    orderPrefix: "MV",
    name,
    image: `https://picsum.photos/seed/${id}/800/500`,
    logo: `https://picsum.photos/seed/${id}-logo/160/160`,
    slug,
    username: slug,
    password: "demo",
    phone: "+21622000000",
    address,
    location: { coordinates: location },
    deliveryTime,
    minimumOrder,
    sections: ["section-1"],
    rating,
    reviewAverage: rating,
    reviewCount,
    isActive: true,
    isAvailable: true,
    stripeDetailsSubmitted: false,
    commissionRate: 10,
    tax: 14,
    notificationToken: "",
    enableNotification: true,
    shopType,
    cuisines,
    keywords: [],
    tags: [],
    reviewData: { total: reviewCount, ratings: rating, reviews: [] },
    categories,
    options: [
      {
        _id: `opt-${id}`,
        title: "Extra topping",
        description: "Optional topping",
        price: 1,
        isOutOfStock: false,
      },
    ],
    addons: [
      {
        _id: `addon-${id}`,
        options: [`opt-${id}`],
        title: "Toppings",
        description: "Optional toppings",
        quantityMinimum: 0,
        quantityMaximum: 3,
      },
    ],
    zone: { _id: "zone-1", title: "Tunis Center", tax: 14 },
    openingTimes,
    restaurantUrl: `https://enatega.local/${slug}`,
  };
}

function createRestaurantOne(openingTimes) {
  return createRestaurantBase({
    id: "res-1",
    name: "Central Kitchen",
    slug: "central-kitchen",
    address: "12 Habib Bourguiba Avenue, Tunis",
    location: [10.1815, 36.8065],
    deliveryTime: 35,
    minimumOrder: 8,
    rating: 4.6,
    reviewCount: 21,
    shopType: "food",
    cuisines: ["American", "Fast Food"],
    categories: [
      {
        _id: "cat-main",
        title: "Main Dishes",
        foods: [
          createFood("food-1", "Classic Burger", "sub-burger", 8.5),
          createFood("food-2", "Chicken Burger", "sub-burger", 7.5),
        ],
      },
      {
        _id: "cat-dessert",
        title: "Desserts",
        foods: [createFood("food-3", "Chocolate Cake", "sub-dessert", 4)],
      },
    ],
    openingTimes,
  });
}

function createRestaurantTwo(openingTimes) {
  return createRestaurantBase({
    id: "res-2",
    name: "Bella Pizza",
    slug: "bella-pizza",
    address: "8 Marseille Street, Tunis",
    location: [10.1702, 36.8042],
    deliveryTime: 40,
    minimumOrder: 10,
    rating: 4.7,
    reviewCount: 14,
    shopType: "food",
    cuisines: ["Italian"],
    categories: [
      {
        _id: "cat-pizza",
        title: "Pizzas",
        foods: [createFood("food-4", "Margherita", "sub-pizza", 12)],
      },
    ],
    openingTimes,
  });
}

function createRestaurantThree(openingTimes) {
  return createRestaurantBase({
    id: "res-3",
    name: "Fresh Salad Bar",
    slug: "fresh-salad-bar",
    address: "25 Lac Street, Tunis",
    location: [10.2158, 36.8472],
    deliveryTime: 25,
    minimumOrder: 7,
    rating: 4.4,
    reviewCount: 9,
    shopType: "grocery",
    cuisines: ["Healthy"],
    categories: [
      {
        _id: "cat-salad",
        title: "Salads",
        foods: [createFood("food-5", "Caesar Salad", "sub-burger", 9)],
      },
    ],
    openingTimes,
  });
}

function createFood(id, title, subCategory, price) {
  return {
    _id: id,
    title,
    image: `https://picsum.photos/seed/${id}/500/320`,
    description: `${title} description`,
    subCategory,
    isOutOfStock: false,
    isActive: true,
    createdAt: nowIso(),
    updatedAt: nowIso(),
    variations: [
      { _id: `var-${id}-1`, title: "Regular", price, discounted: 0, addons: [], isOutOfStock: false },
      { _id: `var-${id}-2`, title: "Large", price: Number((price + 2).toFixed(2)), discounted: 0, addons: [], isOutOfStock: false },
    ],
  };
}

function createDemoUser() {
  return {
    _id: "usr-1",
    name: "Demo Customer",
    email: "demo@enatega.local",
    phone: "+21611111111",
    password: "12345678",
    phoneIsVerified: true,
    emailIsVerified: true,
    picture: "",
    notificationToken: "",
    isOrderNotification: true,
    isOfferNotification: true,
    isActive: true,
    userType: "CUSTOMER",
    userTypeId: "customer",
    favourite: ["res-1"],
    addresses: [
      {
        _id: "addr-1",
        label: "Home",
        deliveryAddress: "14 Main Street, Tunis",
        details: "Apartment 3",
        location: { coordinates: [10.19, 36.817] },
        selected: true,
      },
    ],
  };
}

function createDemoAdminUser(email = "admin@enatega.local", password = "12345678", id = "adm-1") {
  return {
    _id: id,
    name: "Demo Admin",
    email: String(email || "admin@enatega.local"),
    phone: "+21699999999",
    password: String(password || "12345678"),
    phoneIsVerified: true,
    emailIsVerified: true,
    picture: "",
    notificationToken: "",
    isOrderNotification: true,
    isOfferNotification: true,
    isActive: true,
    userType: "ADMIN",
    userTypeId: "admin",
    favourite: [],
    addresses: [],
    permissions: [],
  };
}

function createDemoRider() {
  return {
    _id: "rid-1",
    name: "Demo Rider",
    phone: "+21622222222",
    location: { coordinates: [10.188, 36.811] },
    available: true,
    isActive: true,
  };
}

function createSeedOrderOne(restaurants, users, riders) {
  const restaurant = restaurants[0];
  return {
    _id: "ord-1",
    id: "ord-1",
    orderId: "9001",
    restaurant: buildOrderRestaurant(restaurant),
    deliveryAddress: buildDeliveryAddress(users[0].addresses[0]),
    items: [
      createOrderItem(restaurant.categories[0].foods[0], 1, null),
      createOrderItem(restaurant.categories[1].foods[0], 1, null),
    ],
    user: buildOrderUser(users[0]),
    rider: buildOrderRider(riders[0]),
    review: null,
    paymentMethod: "COD",
    paidAmount: 16.5,
    orderAmount: 12.5,
    discountAmount: 0,
    orderStatus: "PENDING",
    status: "PENDING",
    paymentStatus: "PENDING",
    tipping: 1,
    taxationAmount: 2,
    createdAt: nowIso(),
    completionTime: null,
    preparationTime: 20,
    orderDate: nowIso(),
    expectedTime: futureIso(40 * 60 * 1000),
    isPickedUp: false,
    deliveryCharges: 1,
    acceptedAt: null,
    pickedAt: null,
    deliveredAt: null,
    cancelledAt: null,
    assignedAt: nowIso(),
    instructions: "Call when outside",
    reason: null,
    selectedPrepTime: 20,
  };
}

function createSeedOrderTwo(restaurants, users, riders) {
  const restaurant = restaurants[1];
  return {
    _id: "ord-2",
    id: "ord-2",
    orderId: "9002",
    restaurant: buildOrderRestaurant(restaurant),
    deliveryAddress: buildDeliveryAddress(users[0].addresses[0]),
    items: [createOrderItem(restaurant.categories[0].foods[0], 1, null)],
    user: buildOrderUser(users[0]),
    rider: buildOrderRider(riders[0]),
    review: {
      _id: "rev-1",
      rating: 5,
      description: "Great pizza",
      comments: "Delivered hot and on time",
      isActive: true,
      createdAt: nowIso(),
      updatedAt: nowIso(),
    },
    paymentMethod: "CARD",
    paidAmount: 19,
    orderAmount: 15,
    discountAmount: 0,
    orderStatus: "DELIVERED",
    status: "DELIVERED",
    paymentStatus: "PAID",
    tipping: 2,
    taxationAmount: 2,
    createdAt: nowIso(),
    completionTime: nowIso(),
    preparationTime: 30,
    orderDate: nowIso(),
    expectedTime: nowIso(),
    isPickedUp: true,
    deliveryCharges: 2,
    acceptedAt: nowIso(),
    pickedAt: nowIso(),
    deliveredAt: nowIso(),
    cancelledAt: null,
    assignedAt: nowIso(),
    instructions: "",
    reason: null,
    selectedPrepTime: 30,
  };
}

function randomDelta() {
  return (Math.random() - 0.5) * 0.0015;
}

function nowIso() {
  return new Date().toISOString();
}

function futureIso(durationMs) {
  return new Date(Date.now() + durationMs).toISOString();
}

function randomId(prefix) {
  return `${prefix}-${crypto.randomBytes(4).toString("hex")}`;
}

function safeNumber(value, fallback = 0) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}
